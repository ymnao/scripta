import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, Prec, type Range, Transaction } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
	keymap,
} from "@codemirror/view";

export class BulletWidget extends WidgetType {
	eq(): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const container = document.createElement("span");
		container.className = "cm-list-marker";
		const span = document.createElement("span");
		span.className = "cm-bullet-mark";
		span.textContent = "•";
		container.appendChild(span);
		return container;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

export class CheckboxWidget extends WidgetType {
	constructor(
		readonly checked: boolean,
		readonly pos: number,
	) {
		super();
	}

	eq(other: CheckboxWidget): boolean {
		return this.checked === other.checked && this.pos === other.pos;
	}

	toDOM(): HTMLElement {
		const container = document.createElement("span");
		container.className = "cm-list-marker";
		const span = document.createElement("span");
		span.className = `cm-task-checkbox${this.checked ? " cm-task-checkbox-checked" : ""}`;
		span.dataset.pos = String(this.pos);
		span.setAttribute("role", "checkbox");
		span.setAttribute("aria-checked", String(this.checked));
		span.setAttribute("aria-label", "Toggle task");
		span.tabIndex = 0;
		if (this.checked) {
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("fill", "none");
			svg.setAttribute("aria-hidden", "true");
			svg.classList.add("cm-task-checkmark");
			const path = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
			path.setAttribute("points", "3.5 8 6.5 11 12.5 5");
			path.setAttribute("stroke", "currentColor");
			path.setAttribute("stroke-width", "2");
			path.setAttribute("stroke-linecap", "round");
			path.setAttribute("stroke-linejoin", "round");
			svg.appendChild(path);
			span.appendChild(svg);
		}
		container.appendChild(span);
		return container;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

export function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);

	const ranges: Range<Decoration>[] = [];

	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter(node) {
				if (node.name === "Task") {
					const line = state.doc.lineAt(node.from);

					// Find TaskMarker inside Task node
					const taskNode = node.node;
					let taskMarkerFrom = -1;
					let taskMarkerTo = -1;
					let checked = false;

					const taskCursor = taskNode.cursor();
					if (taskCursor.firstChild()) {
						do {
							if (taskCursor.name === "TaskMarker") {
								taskMarkerFrom = taskCursor.from;
								taskMarkerTo = taskCursor.to;
								const markerText = state.doc.sliceString(taskCursor.from, taskCursor.to);
								checked = markerText === "[x]" || markerText === "[X]";
								break;
							}
						} while (taskCursor.nextSibling());
					}

					if (taskMarkerFrom === -1) return;

					// Find ListMark in parent ListItem
					const parent = taskNode.parent;
					if (!parent || parent.name !== "ListItem") return;

					let listMarkFrom = -1;
					const parentCursor = parent.cursor();
					if (parentCursor.firstChild()) {
						do {
							if (parentCursor.name === "ListMark") {
								listMarkFrom = parentCursor.from;
								break;
							}
						} while (parentCursor.nextSibling());
					}

					if (listMarkFrom === -1) return;

					// Consume TaskMarker trailing space
					let replaceEnd = taskMarkerTo;
					if (replaceEnd < line.to && state.doc.sliceString(replaceEnd, replaceEnd + 1) === " ") {
						replaceEnd += 1;
					}

					// Replace ListMark through TaskMarker with checkbox widget
					ranges.push(
						Decoration.replace({
							widget: new CheckboxWidget(checked, taskMarkerFrom),
						}).range(listMarkFrom, taskMarkerTo),
					);

					// Hide trailing space separately (keeps cursor away from widget boundary)
					if (replaceEnd > taskMarkerTo) {
						ranges.push(Decoration.replace({}).range(taskMarkerTo, replaceEnd));
					}

					// Apply strikethrough for checked tasks
					if (checked) {
						const contentFrom = replaceEnd;
						const lineEnd = line.to;
						if (contentFrom < lineEnd) {
							ranges.push(
								Decoration.mark({ class: "cm-task-checked" }).range(contentFrom, lineEnd),
							);
						}
					}
					return;
				}

				if (node.name === "ListItem") {
					const listItemNode = node.node;
					const parent = listItemNode.parent;
					if (!parent || parent.name !== "BulletList") return;

					// Skip if this ListItem contains a Task child
					const itemCursor = listItemNode.cursor();
					if (itemCursor.firstChild()) {
						do {
							if (itemCursor.name === "Task") return;
						} while (itemCursor.nextSibling());
					}

					// Find ListMark and replace marker + trailing space with bullet widget
					const markCursor = listItemNode.cursor();
					if (markCursor.firstChild()) {
						do {
							if (markCursor.name === "ListMark") {
								const line = state.doc.lineAt(node.from);
								const afterMark = markCursor.to;
								// Only decorate when followed by a space (e.g. "- ")
								if (
									afterMark >= line.to ||
									state.doc.sliceString(afterMark, afterMark + 1) !== " "
								) {
									break;
								}
								const replaceEnd = afterMark + 1;
								ranges.push(
									Decoration.replace({
										widget: new BulletWidget(),
									}).range(markCursor.from, replaceEnd),
								);
								break;
							}
						} while (markCursor.nextSibling());
					}
				}
			},
		});
	}

	return Decoration.set(ranges, true);
}

class ListDecorationPlugin implements PluginValue {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = buildDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.view.composing) {
			if (update.docChanged) this.decorations = this.decorations.map(update.changes);
			return;
		}
		if (
			update.docChanged ||
			update.viewportChanged ||
			syntaxTree(update.state) !== syntaxTree(update.startState)
		) {
			this.decorations = buildDecorations(update.view);
		}
	}
}

/**
 * When a task line is split by Enter, the upper line may become
 * `- [ ]` without a trailing space. The Lezer markdown parser only
 * recognises `- [ ] ` (with space) as a Task, so we append the
 * missing space via a transaction filter.
 *
 * Also handles closeBrackets interaction: when `[` auto-inserts `]`,
 * the cursor ends up inside the marker. We move it past the appended
 * space so it lands outside the decoration range.
 */
const ensureTaskMarkerSpace = EditorState.transactionFilter.of((tr) => {
	if (!tr.docChanged) return tr;

	const newDoc = tr.newDoc;
	const inserts: { from: number; insert: string }[] = [];
	let cursorTarget: number | null = null;

	tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
		const startLine = newDoc.lineAt(fromB).number;
		const endLine = newDoc.lineAt(Math.min(toB, newDoc.length)).number;
		for (let i = startLine; i <= endLine; i++) {
			const line = newDoc.line(i);
			if (/^[ \t]*[-*+][ \t]\[[ xX]\]$/.test(line.text)) {
				inserts.push({ from: line.to, insert: " " });
				// If cursor is inside the task marker (e.g. closeBrackets put it before ']'),
				// move it past the appended space so typing goes after the checkbox widget.
				const head = tr.newSelection.main.head;
				if (head >= line.from && head < line.to) {
					cursorTarget = line.to + 1;
				}
			}
		}
	});

	if (inserts.length === 0) return tr;
	if (cursorTarget !== null) {
		return [
			tr,
			{ changes: inserts, selection: EditorSelection.cursor(cursorTarget), sequential: true },
		];
	}
	return [tr, { changes: inserts, sequential: true }];
});

/** Matches bullet list markers: `- `, `* `, `+ ` with optional leading indent */
const bulletMarkerRe = /^([ \t]*[-*+] )/;
/** Matches task list markers: `- [ ] `, `- [x] `, etc. with optional leading indent */
const taskMarkerRe = /^([ \t]*[-*+] \[[ xX]\] )/;

/**
 * Find the marker range (ListMark + optional TaskMarker + trailing space)
 * for a bullet/task list item on the given line using regex.
 * Returns `{ from, to }` or `null` if not found.
 */
export function findMarkerRange(
	state: EditorState,
	line: { from: number; to: number; number: number },
): { from: number; to: number } | null {
	const text = state.doc.sliceString(line.from, line.to);
	const taskMatch = taskMarkerRe.exec(text);
	if (taskMatch) {
		return { from: line.from, to: line.from + taskMatch[1].length };
	}
	const bulletMatch = bulletMarkerRe.exec(text);
	if (bulletMatch) {
		return { from: line.from, to: line.from + bulletMatch[1].length };
	}
	return null;
}

/**
 * Backspace on the content start of a bullet/task list item deletes
 * the entire marker (and task marker) + trailing space in one
 * keystroke, so the line immediately becomes plain text.
 *
 * ArrowLeft at the content start skips the hidden marker area and
 * moves the cursor to the end of the previous line.
 *
 * Wrapped in Prec.high so it runs before defaultKeymap's
 * deleteCharBackward (which always returns true and would otherwise
 * swallow the event).
 */
export const listKeymap = [
	ensureTaskMarkerSpace,
	Prec.high(
		keymap.of([
			{
				key: "Backspace",
				run(view) {
					const { state } = view;
					const { main } = state.selection;
					if (!main.empty) return false;

					const head = main.head;
					const line = state.doc.lineAt(head);
					if (head === line.from) return false;

					const range = findMarkerRange(state, line);
					if (!range) return false;
					if (head <= range.from || head > range.to) return false;

					view.dispatch({
						changes: { from: range.from, to: range.to },
						annotations: Transaction.userEvent.of("delete.backward"),
					});
					return true;
				},
			},
			{
				key: "ArrowLeft",
				run(view) {
					const { state } = view;
					const { main } = state.selection;
					if (!main.empty) return false;

					const head = main.head;
					const line = state.doc.lineAt(head);
					const range = findMarkerRange(state, line);
					if (!range) return false;

					// Cursor is within or at the end of the marker area
					if (head > range.from && head <= range.to) {
						if (line.number <= 1) return false;
						const prevLine = state.doc.line(line.number - 1);
						view.dispatch({
							selection: EditorSelection.cursor(prevLine.to),
						});
						return true;
					}
					return false;
				},
			},
			{
				key: "ArrowRight",
				run(view) {
					const { state } = view;
					const { main } = state.selection;
					if (!main.empty) return false;

					const head = main.head;
					const line = state.doc.lineAt(head);

					// At end of line, check if next line has a marker to skip
					if (head === line.to && line.number < state.doc.lines) {
						const nextLine = state.doc.line(line.number + 1);
						const range = findMarkerRange(state, nextLine);
						if (range) {
							view.dispatch({
								selection: EditorSelection.cursor(range.to),
							});
							return true;
						}
					}

					// Inside marker area, jump to content start
					const range = findMarkerRange(state, line);
					if (range && head >= range.from && head < range.to) {
						view.dispatch({
							selection: EditorSelection.cursor(range.to),
						});
						return true;
					}
					return false;
				},
			},
		]),
	),
];

function toggleCheckbox(view: EditorView, checkbox: Element): void {
	const pos = Number((checkbox as HTMLElement).dataset.pos);
	if (Number.isNaN(pos) || pos < 0 || pos + 3 > view.state.doc.length) return;
	const current = view.state.doc.sliceString(pos, pos + 3);
	const newText = current === "[x]" || current === "[X]" ? "[ ]" : "[x]";
	view.dispatch({
		changes: { from: pos, to: pos + 3, insert: newText },
		annotations: Transaction.userEvent.of("input"),
	});
}

export const listDecoration = ViewPlugin.fromClass(ListDecorationPlugin, {
	decorations: (v) => v.decorations,
	eventHandlers: {
		click(event: MouseEvent, view: EditorView) {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const checkbox = target.closest(".cm-task-checkbox");
			if (!checkbox) return;
			event.preventDefault();
			toggleCheckbox(view, checkbox);
		},
		keydown(event: KeyboardEvent, view: EditorView) {
			if (event.key !== " " && event.key !== "Enter") return;
			const target = event.target;
			if (!(target instanceof Element)) return;
			const checkbox = target.closest(".cm-task-checkbox");
			if (!checkbox) return;
			event.preventDefault();
			toggleCheckbox(view, checkbox);
		},
	},
});
