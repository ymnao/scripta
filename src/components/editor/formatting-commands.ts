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

export const toggleBold: Command = (view) => toggleWrap(view, "**");

export const toggleItalic: Command = (view) => toggleWrap(view, "*");

export const toggleStrikethrough: Command = (view) => toggleWrap(view, "~~");

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
