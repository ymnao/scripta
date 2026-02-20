import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";

const replaceDecoration = Decoration.replace({});

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
		const input = document.createElement("input");
		input.type = "checkbox";
		input.className = "cm-task-checkbox";
		input.checked = this.checked;
		input.dataset.pos = String(this.pos);
		return input;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

export function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);

	const cursorLines = new Set<number>();
	for (const range of state.selection.ranges) {
		const fromLine = state.doc.lineAt(range.from).number;
		const toLine = state.doc.lineAt(range.to).number;
		for (let l = fromLine; l <= toLine; l++) {
			cursorLines.add(l);
		}
	}

	const ranges: Range<Decoration>[] = [];

	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter(node) {
				if (node.name !== "Task") return;

				const line = state.doc.lineAt(node.from);
				if (cursorLines.has(line.number)) return;

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
			update.selectionSet ||
			syntaxTree(update.state) !== syntaxTree(update.startState)
		) {
			this.decorations = buildDecorations(update.view);
		}
	}
}

export const listDecoration = ViewPlugin.fromClass(ListDecorationPlugin, {
	decorations: (v) => v.decorations,
	eventHandlers: {
		mousedown(event: MouseEvent, view: EditorView) {
			const target = event.target;
			if (!(target instanceof HTMLInputElement)) return;
			if (!target.classList.contains("cm-task-checkbox")) return;

			event.preventDefault();
			const pos = Number(target.dataset.pos);
			const current = view.state.doc.sliceString(pos, pos + 3);
			const newText = current === "[x]" || current === "[X]" ? "[ ]" : "[x]";
			view.dispatch({ changes: { from: pos, to: pos + 3, insert: newText } });
		},
	},
});
