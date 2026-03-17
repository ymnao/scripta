import type { EditorView } from "@codemirror/view";

type Command = (view: EditorView) => boolean;

function toggleWrap(view: EditorView, marker: string): boolean {
	const { from, to } = view.state.selection.main;
	const selected = view.state.sliceDoc(from, to);
	const len = marker.length;

	if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= len * 2) {
		// Guard against false matches: for a single-char marker like "*",
		// ensure we're not actually inside a longer marker (e.g. "**").
		// If the inner text still starts/ends with the marker char, the selection
		// is wrapped with a longer marker (e.g. "**bold**"), so don't unwrap.
		const inner = selected.slice(len, -len);
		if (len === 1 && inner.length > 0 && (inner.startsWith(marker) || inner.endsWith(marker))) {
			// Not our marker — wrap instead
			view.dispatch({
				changes: { from, to, insert: marker + selected + marker },
			});
		} else {
			view.dispatch({
				changes: { from, to, insert: inner },
			});
		}
	} else {
		view.dispatch({
			changes: { from, to, insert: marker + selected + marker },
		});
	}
	return true;
}

export const toggleList: Command = (view) => {
	const { head } = view.state.selection.main;
	const line = view.state.doc.lineAt(head);
	const text = line.text;

	// Match list markers (with optional checkbox)
	const listMatch = text.match(/^(\s*)([-*+])\s(\[[ xX]\]\s)?/);
	if (listMatch) {
		const wsLen = listMatch[1].length;
		const markerEnd = line.from + listMatch[0].length;
		view.dispatch({
			changes: { from: line.from + wsLen, to: markerEnd, insert: "" },
		});
	} else {
		const wsMatch = text.match(/^(\s*)/);
		const wsLen = wsMatch ? wsMatch[1].length : 0;
		view.dispatch({
			changes: { from: line.from + wsLen, to: line.from + wsLen, insert: "- " },
		});
	}
	return true;
};

export const toggleCheckbox: Command = (view) => {
	const { head } = view.state.selection.main;
	const line = view.state.doc.lineAt(head);
	const text = line.text;

	// Already has checkbox → remove it (strip entire list + checkbox)
	const checkboxMatch = text.match(/^(\s*)([-*+])\s\[[ xX]\]\s/);
	if (checkboxMatch) {
		const wsLen = checkboxMatch[1].length;
		const markerEnd = line.from + checkboxMatch[0].length;
		view.dispatch({
			changes: { from: line.from + wsLen, to: markerEnd, insert: "" },
		});
		return true;
	}

	// Plain line (or list without checkbox) → add - [ ]
	// First strip existing list marker if present
	const listMatch = text.match(/^(\s*)([-*+])\s/);
	if (listMatch) {
		const wsLen = listMatch[1].length;
		const markerEnd = line.from + listMatch[0].length;
		view.dispatch({
			changes: { from: line.from + wsLen, to: markerEnd, insert: "- [ ] " },
		});
	} else {
		const wsMatch = text.match(/^(\s*)/);
		const wsLen = wsMatch ? wsMatch[1].length : 0;
		view.dispatch({
			changes: { from: line.from + wsLen, to: line.from + wsLen, insert: "- [ ] " },
		});
	}
	return true;
};

export const toggleCheckState: Command = (view) => {
	const { head } = view.state.selection.main;
	const line = view.state.doc.lineAt(head);
	const text = line.text;

	// Unchecked: [ ] → [x]
	const uncheckedMatch = text.match(/^(\s*[-*+]\s)\[ \]/);
	if (uncheckedMatch) {
		const pos = line.from + uncheckedMatch[1].length;
		view.dispatch({
			changes: { from: pos, to: pos + 3, insert: "[x]" },
		});
		return true;
	}

	// Checked: [x] → [ ]
	const checkedMatch = text.match(/^(\s*[-*+]\s)\[[xX]\]/);
	if (checkedMatch) {
		const pos = line.from + checkedMatch[1].length;
		view.dispatch({
			changes: { from: pos, to: pos + 3, insert: "[ ]" },
		});
		return true;
	}

	// Not a checkbox line — don't consume the event
	return false;
};

export const toggleBold: Command = (view) => toggleWrap(view, "**");

export const toggleItalic: Command = (view) => toggleWrap(view, "*");

export const toggleStrikethrough: Command = (view) => toggleWrap(view, "~~");

function insertBlock(view: EditorView, block: string): boolean {
	const pos = view.state.selection.main.head;
	const line = view.state.doc.lineAt(pos);
	const needsNewline = line.text.trim().length > 0;
	const insert = needsNewline ? `\n${block}` : block;
	const insertAt = needsNewline ? line.to : line.from;
	view.dispatch({
		changes: { from: insertAt, to: needsNewline ? insertAt : line.to, insert },
	});
	return true;
}

export const insertHorizontalRule: Command = (view) => insertBlock(view, "---");

export function toggleHeading(level: number): Command {
	const prefix = `${"#".repeat(level)} `;
	return (view) => {
		const { head } = view.state.selection.main;
		const line = view.state.doc.lineAt(head);
		const text = line.text;

		const match = text.match(/^(#{1,6})\s/);
		if (match) {
			const existing = match[0];
			if (existing === prefix) {
				// Same level — remove heading
				view.dispatch({
					changes: { from: line.from, to: line.from + existing.length, insert: "" },
				});
			} else {
				// Different level — replace
				view.dispatch({
					changes: { from: line.from, to: line.from + existing.length, insert: prefix },
				});
			}
		} else {
			// No heading — add
			view.dispatch({
				changes: { from: line.from, to: line.from, insert: prefix },
			});
		}
		return true;
	};
}
