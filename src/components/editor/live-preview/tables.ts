import { type Extension, Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { focusTableCellEffect } from "./table-decoration";
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

// ── Extension ─────────────────────────────────────────

export const tableKeymap: Extension = Prec.high(
	keymap.of([{ key: "Alt-Shift-t", mac: "Ctrl-Shift-t", run: insertTable }]),
);
