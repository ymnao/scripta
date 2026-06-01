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
	// それ以外: 現在行の直後にテーブルを差し込む（先頭に改行を付ける）。
	const insertFrom = onEmptyLine ? line.from : line.to;
	const prefix = onEmptyLine ? "" : "\n";

	// テーブル直下に編集可能な行を 1 行だけ確保する（idempotent）。挿入後に
	// テーブルの真下へ来る行は元ドキュメントの次行（または EOF）に相当する。
	// 既に空行があれば足さず、無ければ改行を 1 つだけ補って行を作る（余分な
	// 空行は作らない）。git 用のファイル末尾改行は別概念で、保存時の
	// processContent（src/lib/content.ts）が担うのでここでは扱わない。
	const suffix = isLineBlank(state.doc, line.number + 1) ? "" : "\n";

	const insert = `${prefix}${template}${suffix}`;

	// After the transaction, the table starts at insertFrom (empty line)
	// or at insertFrom + 1 (non-empty line, due to prepended \n)
	const tableFrom = onEmptyLine ? insertFrom : insertFrom + 1;

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

function arrowDownIntoTable(view: EditorView): boolean {
	const sel = view.state.selection.main;
	const line = view.state.doc.lineAt(sel.head);
	const tableNode = findTableNodeAt(view, line.number + 1);
	if (!tableNode) return false;

	// On wrapped lines, only intercept when cursor is on the last visual line
	const moved = view.moveVertically(sel, true);
	if (view.state.doc.lineAt(moved.head).number === line.number) return false;

	const widget = findWidgetForTable(view, tableNode.from);
	if (!widget) return false;

	focusCell(widget, 0, 0);
	return true;
}

function arrowUpIntoTable(view: EditorView): boolean {
	const sel = view.state.selection.main;
	const line = view.state.doc.lineAt(sel.head);
	const tableNode = findTableNodeAt(view, line.number - 1);
	if (!tableNode) return false;

	// On wrapped lines, only intercept when cursor is on the first visual line
	const moved = view.moveVertically(sel, false);
	if (view.state.doc.lineAt(moved.head).number === line.number) return false;

	const widget = findWidgetForTable(view, tableNode.from);
	if (!widget) return false;

	// Find last row index
	const allCells = widget.querySelectorAll("[data-row]");
	let maxRow = 0;
	for (const cell of allCells) {
		maxRow = Math.max(maxRow, Number((cell as HTMLElement).dataset.row));
	}
	focusCell(widget, maxRow, 0);
	return true;
}

// ── Extension ─────────────────────────────────────────

export const tableKeymap: Extension = Prec.high(
	keymap.of([
		{ key: "Mod-Shift-t", run: insertTable },
		{ key: "ArrowDown", run: arrowDownIntoTable },
		{ key: "ArrowUp", run: arrowUpIntoTable },
	]),
);
