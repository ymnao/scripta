import { syntaxTree } from "@codemirror/language";
import { EditorState, Prec, type Range, Transaction } from "@codemirror/state";
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

const replaceDecoration = Decoration.replace({});

export class BulletWidget extends WidgetType {
	eq(): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const span = document.createElement("span");
		span.className = "cm-bullet-mark";
		span.textContent = "•";
		return span;
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
		const span = document.createElement("span");
		span.className = `cm-task-checkbox${this.checked ? " cm-task-checkbox-checked" : ""}`;
		span.dataset.pos = String(this.pos);
		span.setAttribute("role", "checkbox");
		span.setAttribute("aria-checked", String(this.checked));
		span.setAttribute("aria-label", "Toggle task");
		if (this.checked) {
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("fill", "none");
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
		return span;
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

					// Hide ListMark + space before TaskMarker
					ranges.push(replaceDecoration.range(listMarkFrom, taskMarkerFrom));

					// Replace TaskMarker with checkbox widget
					ranges.push(
						Decoration.replace({
							widget: new CheckboxWidget(checked, taskMarkerFrom),
						}).range(taskMarkerFrom, taskMarkerTo),
					);

					// Apply strikethrough for checked tasks
					if (checked) {
						const contentFrom = taskMarkerTo + 1;
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
								let replaceEnd = markCursor.to;
								if (
									replaceEnd < line.to &&
									state.doc.sliceString(replaceEnd, replaceEnd + 1) === " "
								) {
									replaceEnd += 1;
								}
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
 */
const ensureTaskMarkerSpace = EditorState.transactionFilter.of((tr) => {
	if (!tr.docChanged) return tr;

	const newDoc = tr.newDoc;
	const inserts: { from: number; insert: string }[] = [];

	tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
		const startLine = newDoc.lineAt(fromB).number;
		const endLine = newDoc.lineAt(Math.min(toB, newDoc.length)).number;
		for (let i = startLine; i <= endLine; i++) {
			const line = newDoc.line(i);
			if (/^[ \t]*[-*+][ \t]\[[ xX]\]$/.test(line.text)) {
				inserts.push({ from: line.to, insert: " " });
			}
		}
	});

	if (inserts.length === 0) return tr;
	return [tr, { changes: inserts, sequential: true }];
});

/**
 * Backspace on the content start of a bullet/task list item deletes
 * the entire marker (and task marker) + trailing space in one
 * keystroke, so the line immediately becomes plain text.
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

					const tree = syntaxTree(state);
					let deleteFrom = -1;
					let deleteTo = -1;

					tree.iterate({
						from: line.from,
						to: line.to,
						enter(node) {
							if (node.name !== "ListItem") return;

							const listItemNode = node.node;
							if (listItemNode.parent?.name !== "BulletList") return false;

							// Only handle ListItem whose markers are on the cursor's line
							if (state.doc.lineAt(node.from).number !== line.number) return false;

							// Find ListMark
							let listMarkFrom = -1;
							let contentEnd = -1;
							const itemCursor = listItemNode.cursor();
							if (itemCursor.firstChild()) {
								do {
									if (itemCursor.name === "ListMark") {
										listMarkFrom = itemCursor.from;
										contentEnd = itemCursor.to;
										if (
											contentEnd < line.to &&
											state.doc.sliceString(contentEnd, contentEnd + 1) === " "
										) {
											contentEnd += 1;
										}
										break;
									}
								} while (itemCursor.nextSibling());
							}
							if (listMarkFrom === -1) return false;

							// Extend range if there is a Task > TaskMarker
							const itemCursor2 = listItemNode.cursor();
							if (itemCursor2.firstChild()) {
								do {
									if (itemCursor2.name === "Task") {
										const taskCursor = itemCursor2.node.cursor();
										if (taskCursor.firstChild()) {
											do {
												if (taskCursor.name === "TaskMarker") {
													contentEnd = taskCursor.to;
													if (
														contentEnd < line.to &&
														state.doc.sliceString(contentEnd, contentEnd + 1) === " "
													) {
														contentEnd += 1;
													}
													break;
												}
											} while (taskCursor.nextSibling());
										}
										break;
									}
								} while (itemCursor2.nextSibling());
							}

							// Accept Backspace if cursor is within the marker area
							if (head > listMarkFrom && head <= contentEnd) {
								deleteFrom = listMarkFrom;
								deleteTo = contentEnd;
							}

							return false;
						},
					});

					if (deleteFrom === -1) return false;

					view.dispatch({
						changes: { from: deleteFrom, to: deleteTo },
						annotations: Transaction.userEvent.of("delete.backward"),
					});
					return true;
				},
			},
		]),
	),
];

export const listDecoration = ViewPlugin.fromClass(ListDecorationPlugin, {
	decorations: (v) => v.decorations,
	eventHandlers: {
		click(event: MouseEvent, view: EditorView) {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const checkbox = target.closest(".cm-task-checkbox");
			if (!checkbox) return;

			event.preventDefault();
			const pos = Number((checkbox as HTMLElement).dataset.pos);
			if (Number.isNaN(pos) || pos < 0 || pos + 3 > view.state.doc.length) return;
			const current = view.state.doc.sliceString(pos, pos + 3);
			const newText = current === "[x]" || current === "[X]" ? "[ ]" : "[x]";
			view.dispatch({
				changes: { from: pos, to: pos + 3, insert: newText },
				annotations: Transaction.userEvent.of("input"),
			});
			return true;
		},
	},
});
