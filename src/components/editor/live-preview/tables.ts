import { syntaxTree } from "@codemirror/language";
import { type Extension, Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { focusCell, focusTableCellEffect } from "./table-decoration";
import { createEmptyTable } from "./table-utils";

// ── Insert table (Ctrl-Shift-t / Alt-Shift-t) ────────

export function insertTable(view: EditorView): boolean {
	const { state } = view;
	const pos = state.selection.main.head;
	const line = state.doc.lineAt(pos);

	const template = createEmptyTable(3, 2);
	let insert = template;
	let insertFrom = pos;

	if (line.text.trim().length > 0) {
		insert = `\n${template}`;
		insertFrom = line.to;
	} else {
		insertFrom = line.from;
	}

	view.dispatch({
		changes: {
			from: insertFrom,
			to: insertFrom === line.from ? line.to : insertFrom,
			insert,
		},
		effects: [focusTableCellEffect.of({ row: 0, col: 0 })],
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
		if (node.name === "Table") return { from: node.from };
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
		{ key: "Alt-Shift-t", mac: "Ctrl-Shift-t", run: insertTable },
		{ key: "ArrowDown", run: arrowDownIntoTable },
		{ key: "ArrowUp", run: arrowUpIntoTable },
	]),
);
