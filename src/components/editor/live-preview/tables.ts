import { syntaxTree } from "@codemirror/language";
import { type Extension, Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { focusCell, focusTableCellEffect } from "./table-decoration";
import { createEmptyTable, isLineBlank } from "./table-utils";

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
