import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { getStringWidth } from "../../../lib/east-asian-width";
import { focusCell, focusTableCellEffect, parseTsv } from "./table-decoration";
import { createEmptyTable, isLineBlank, trimToLastTableLine } from "./table-utils";

// ── Insert table (Mod-Shift-t) ────────

export function insertTable(view: EditorView): boolean {
	const { state } = view;
	const pos = state.selection.main.head;
	const line = state.doc.lineAt(pos);
	const onEmptyLine = line.text.trim().length === 0;

	const template = createEmptyTable(3, 2);

	// onEmptyLine: テーブルで現在の空行を置き換える。
	// それ以外: 現在行の直後にテーブルを差し込む。
	// テーブルの直前に本文が密着すると lezer がテーブルを認識できず（本文段落の続きと
	// 解釈され）、当該テーブルだけでなく周辺のテーブルもプレーンテキスト化してしまう。
	// 「現在行が空行でも、その直上が本文行」のケースも同じ密着が起きるので、ここでも
	// 1 つ \n を補って空行をはさむ。
	const insertFrom = onEmptyLine ? line.from : line.to;
	const prevLineBlank = line.number === 1 || isLineBlank(state.doc, line.number - 1);
	const prefix = onEmptyLine ? (prevLineBlank ? "" : "\n") : "\n\n";

	// テーブル直下に編集可能な行を 1 行だけ確保する（idempotent）。挿入後に
	// テーブルの真下へ来る行は元ドキュメントの次行（または EOF）に相当する。
	// 既に空行があれば足さず、無ければ改行を 1 つだけ補って行を作る（余分な
	// 空行は作らない）。git 用のファイル末尾改行は別概念で、保存時の
	// processContent（src/lib/content.ts）が担うのでここでは扱わない。
	const suffix = isLineBlank(state.doc, line.number + 1) ? "" : "\n";

	const insert = `${prefix}${template}${suffix}`;

	// 変換後にテーブルが始まる位置 = insertFrom + prefix の長さ。
	const tableFrom = insertFrom + prefix.length;

	view.dispatch({
		changes: { from: insertFrom, to: line.to, insert },
		effects: [focusTableCellEffect.of({ tableFrom, row: 0, col: 0 })],
	});
	return true;
}

// ── Arrow key navigation into table widgets ──────────

function findTableNodeAt(view: EditorView, lineNum: number): { from: number } | null {
	if (lineNum < 1 || lineNum > view.state.doc.lines) return null;
	const lineFrom = view.state.doc.line(lineNum).from;
	const tree = syntaxTree(view.state);
	let node = tree.resolve(lineFrom, 1);
	while (node) {
		if (node.name === "Table") return { from: view.state.doc.lineAt(node.from).from };
		if (!node.parent) break;
		node = node.parent;
	}
	return null;
}

function findWidgetForTable(view: EditorView, tableFrom: number): HTMLElement | null {
	return view.dom.querySelector(
		`.cm-table-widget[data-table-from="${tableFrom}"]`,
	) as HTMLElement | null;
}

function lastRowOf(widget: HTMLElement): number {
	let maxRow = 0;
	for (const cell of widget.querySelectorAll("[data-row]")) {
		maxRow = Math.max(maxRow, Number((cell as HTMLElement).dataset.row));
	}
	return maxRow;
}

function lastColOf(widget: HTMLElement, row: number): number {
	let maxCol = 0;
	for (const cell of widget.querySelectorAll(`[data-row="${row}"]`)) {
		maxCol = Math.max(maxCol, Number((cell as HTMLElement).dataset.col));
	}
	return maxCol;
}

/** `tableLine` 行に Table widget があれば `pickCell` が指すセルへフォーカスを移す。 */
function enterTableAt(
	view: EditorView,
	tableLine: number,
	pickCell: (widget: HTMLElement) => [number, number],
): boolean {
	const tableNode = findTableNodeAt(view, tableLine);
	if (!tableNode) return false;
	const widget = findWidgetForTable(view, tableNode.from);
	if (!widget) return false;
	const [row, col] = pickCell(widget);
	focusCell(widget, row, col);
	return true;
}

function arrowDownIntoTable(view: EditorView): boolean {
	const sel = view.state.selection.main;
	const line = view.state.doc.lineAt(sel.head);
	// 折り返し行のときは最終ビジュアル行にいるときだけ介入する
	const moved = view.moveVertically(sel, true);
	if (view.state.doc.lineAt(moved.head).number === line.number) return false;
	return enterTableAt(view, line.number + 1, () => [0, 0]);
}

function arrowUpIntoTable(view: EditorView): boolean {
	const sel = view.state.selection.main;
	const line = view.state.doc.lineAt(sel.head);
	// 折り返し行のときは先頭ビジュアル行にいるときだけ介入する
	const moved = view.moveVertically(sel, false);
	if (view.state.doc.lineAt(moved.head).number === line.number) return false;
	return enterTableAt(view, line.number - 1, (w) => [lastRowOf(w), 0]);
}

function arrowRightIntoTable(view: EditorView): boolean {
	// 表の直前行の末尾で Right → 表 (0,0) セルへ入る。CM の既定では表内（block widget）
	// の左端境界に着地し巨大キャレットが描画されてしまうのを防ぐ。
	const sel = view.state.selection.main;
	if (!sel.empty) return false;
	const line = view.state.doc.lineAt(sel.head);
	if (sel.head !== line.to) return false;
	return enterTableAt(view, line.number + 1, () => [0, 0]);
}

function arrowLeftIntoTable(view: EditorView): boolean {
	// 表の直後行の先頭で Left → 表の右下セル（最終行・最終列）へ入る。
	const sel = view.state.selection.main;
	if (!sel.empty) return false;
	const line = view.state.doc.lineAt(sel.head);
	if (sel.head !== line.from || line.number <= 1) return false;
	return enterTableAt(view, line.number - 1, (w) => {
		const r = lastRowOf(w);
		return [r, lastColOf(w, r)];
	});
}

// ── Backspace at the line directly below a table ─────────

// 行頭での Backspace は CM 既定では直前の改行を消し、テーブル直下の本文行を
// テーブル最終行へマージしてしまう（`| 1 | 2 |` + `text` → `| 1 | 2 |text` と
// なり列が増え巨大キャレットが出る）。直上がテーブル最終行で現在行が非空のときは
// マージせず、ArrowUp と同じく最終行先頭セルへカーソルを入れる（下からテーブルへ
// 入る挙動）。空行の場合は既定の削除に任せる（テーブル直下の空行を詰める挙動を維持）。
function backspaceIntoTableFromBelow(view: EditorView): boolean {
	const sel = view.state.selection.main;
	if (!sel.empty) return false;
	const line = view.state.doc.lineAt(sel.head);
	if (sel.head !== line.from || line.number <= 1) return false;
	// 空行は既定に任せる（直上テーブル行へマージしても行内容は変わらず無害）
	if (line.text.length === 0) return false;
	return enterTableAt(view, line.number - 1, (w) => [lastRowOf(w), 0]);
}

// ── Extension ─────────────────────────────────────────

export const tableKeymap: Extension = Prec.high(
	keymap.of([
		{ key: "Mod-Shift-t", run: insertTable },
		{ key: "ArrowDown", run: arrowDownIntoTable },
		{ key: "ArrowUp", run: arrowUpIntoTable },
		{ key: "ArrowRight", run: arrowRightIntoTable },
		{ key: "ArrowLeft", run: arrowLeftIntoTable },
		{ key: "Backspace", run: backspaceIntoTableFromBelow },
	]),
);

// ── TSV paste → Markdown table (#147) ────────────────

/** 指定範囲が FencedCode / CodeBlock / InlineCode / Table ノードと重なるか判定する。
 *  from === to（空カーソル）ではその位置を含むノードを検出する（inclusive）。
 *  from < to（非空選択）では半開区間 [from, to) として判定し、選択範囲が
 *  コード/テーブルの直前で終わるだけの境界接触は「重なり」としない。
 *
 *  syntaxTree().iterate({ from, to }) は inclusive に重なるノードを返すため、
 *  非空選択では iterate が返した境界ノードを追加フィルタで除外する。
 *
 *  Table ノードは lezer が直後の本文行まで含めてしまうことがあるため、
 *  trimToLastTableLine でパイプを含む最後の行まで詰めた実際の範囲で判定する
 *  （table-decoration.ts の buildTableDecorations / findTableNode と同じ補正）。 */
export function rangeOverlapsCodeOrTable(state: EditorState, from: number, to: number): boolean {
	const doc = state.doc;
	const isEmpty = from === to;
	let found = false;
	syntaxTree(state).iterate({
		from,
		to,
		enter(node) {
			if (found) return false;
			if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "InlineCode") {
				// 非空選択: 半開区間で重ならない境界接触を除外
				if (!isEmpty && (node.from >= to || node.to <= from)) return false;
				found = true;
				return false;
			}
			if (node.name === "Table") {
				// lezer の Table 範囲をパイプ行末尾まで詰める
				const startLine = doc.lineAt(node.from).number;
				const rawEndLine = doc.lineAt(node.to).number;
				const trimmedEndLine = trimToLastTableLine(doc, startLine, rawEndLine);
				const trimmedTo = doc.line(trimmedEndLine).to;
				if (isEmpty) {
					// 空カーソル: inclusive（カーソルがテーブル内にあるか）
					if (node.from <= from && trimmedTo >= from) {
						found = true;
					}
				} else {
					// 非空選択: 半開区間の重なり（境界接触のみは除外）
					if (node.from < to && trimmedTo > from) {
						found = true;
					}
				}
				return false;
			}
		},
	});
	return found;
}

export function tsvToMarkdownTable(grid: string[][]): string {
	const colCount = Math.max(...grid.map((row) => row.length));
	// セル内改行をスペースに正規化してからパイプをエスケープする。
	// parseTsv は quoted field 内の改行を保持するが、Markdown テーブルの行中に
	// 改行があるとテーブル構造が壊れる（table-decoration.ts の sanitizePasteText と同じ方針）。
	//
	// パイプのエスケープは findUnescapedPipe（table-utils.ts）と整合させる必要がある。
	// パーサーは | 直前の連続 \ が偶数なら未エスケープ区切りとして扱うため、
	// 単純な replace(/\|/g, "\\|") では入力 `a\|b` が `a\\|b`（偶数 → 区切り）になり
	// 1 セルが 2 セルに割れる。(\\*)\| で直前の \ 列を倍にして無効化してから \| を
	// 付加することで、出力の | 直前は常に奇数個の \ になる。
	const escapeCell = (s: string) =>
		s
			.replace(/[\r\n]+/g, " ")
			.replace(/(\\*)\|/g, (_, bs: string) => `${"\\".repeat(bs.length * 2)}\\|`)
			.trim();

	// 表示幅ベースで列幅を計算（CJK 全角文字を 2 カラムとして扱う）
	const widths = Array.from({ length: colCount }, (_, c) =>
		Math.max(3, ...grid.map((row) => (c < row.length ? getStringWidth(escapeCell(row[c])) : 0))),
	);

	const formatRow = (row: string[]) => {
		const parts = Array.from({ length: colCount }, (_, c) => {
			const content = c < row.length ? escapeCell(row[c]) : "";
			const pad = widths[c] - getStringWidth(content);
			return content + " ".repeat(Math.max(0, pad));
		});
		return `| ${parts.join(" | ")} |`;
	};

	const separator = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
	const [header, ...dataRows] = grid;
	return [formatRow(header), separator, ...dataRows.map(formatRow)].join("\n");
}

/**
 * TSV ペースト時のテーブル挿入変更を構築する。
 *
 * 3 つのケースを処理する:
 * 1. 空行上の空カーソル → 行全体をテーブルで置き換え
 * 2. 非空行の空カーソル → 行末 (fromLine.to) に挿入（行中位置によらない）
 * 3. 選択あり → 選択後の行内テキストを退避し、置換範囲を行末まで拡張
 *
 * ケース 2/3 はテーブル（ブロック要素）が行内テキストに直結してパース不能に
 * なるのを防ぐ。
 */
export function buildTsvTableChanges(state: EditorState, md: string) {
	return state.changeByRange((range) => {
		const fromLine = state.doc.lineAt(range.from);
		const toLine = state.doc.lineAt(range.to);

		const onEmptyLine = range.empty && fromLine.text.trim().length === 0;

		let from: number;
		let to: number;
		let trailing = "";

		if (onEmptyLine) {
			// 空行 → 行全体をテーブルで置き換える
			from = fromLine.from;
			to = fromLine.to;
		} else if (range.empty) {
			// 非空行の空カーソル → 行末に挿入（行中位置によらずテーブルは行の後に配置）
			from = fromLine.to;
			to = fromLine.to;
		} else {
			// 選択あり → 選択後の行内テキストを退避し、置換範囲を行末まで拡張
			from = range.from;
			to = toLine.to;
			const afterSel = state.doc.sliceString(range.to, toLine.to);
			if (afterSel.trim().length > 0) {
				trailing = afterSel;
			}
		}

		// テーブル前後に空行を確保（lezer がテーブルを認識するために必要）
		const atLineStart = from === fromLine.from;
		const prevLineBlank = fromLine.number === 1 || isLineBlank(state.doc, fromLine.number - 1);
		const prefix = from === 0 || (atLineStart && prevLineBlank) ? "" : atLineStart ? "\n" : "\n\n";

		const nextLineNum = toLine.number + 1;
		const nextLineBlank = nextLineNum > state.doc.lines || isLineBlank(state.doc, nextLineNum);
		// trailing がある場合は空行を挟んでテーブル後に別行として配置する。
		// trailing が無い場合は後続行との分離のみ考慮する。
		const suffix = trailing ? `\n\n${trailing}` : nextLineBlank ? "" : "\n";

		const insert = `${prefix}${md}${suffix}`;
		return {
			range: EditorSelection.cursor(from + insert.length),
			changes: { from, to, insert },
		};
	});
}

export const tsvPasteHandler: Extension = EditorView.domEventHandlers({
	paste(event: ClipboardEvent, view: EditorView) {
		if (event.defaultPrevented) return false;

		const text = event.clipboardData?.getData("text/plain");
		if (!text?.includes("\t")) return false;

		const active = document.activeElement;
		if (active instanceof HTMLElement && active.closest(".cm-table-widget")) return false;

		const { state } = view;
		// いずれかの range がコード / 既存テーブルと重なるなら plain paste に委ねる
		if (state.selection.ranges.some((r) => rangeOverlapsCodeOrTable(state, r.from, r.to)))
			return false;

		const grid = parseTsv(text);
		if (grid.length === 0) return false;

		event.preventDefault();

		const md = tsvToMarkdownTable(grid);
		view.dispatch({ ...buildTsvTableChanges(state, md), userEvent: "input.paste" });
		return true;
	},
});
