import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { collectCursorLines, cursorInRange, cursorLinesChanged } from "./cursor-utils";

const replaceDecoration = Decoration.replace({});

function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);

	const cursorLines = collectCursorLines(view);

	const ranges: Range<Decoration>[] = [];

	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter(node) {
				if (node.name !== "Emphasis" && node.name !== "StrongEmphasis") {
					return;
				}

				const startLine = state.doc.lineAt(node.from).number;
				const endLine = state.doc.lineAt(node.to).number;
				if (cursorInRange(cursorLines, startLine, endLine)) return;

				const cursor = node.node.cursor();
				if (!cursor.firstChild()) return;

				let contentFrom = -1;
				let contentTo = -1;

				do {
					if (cursor.name === "EmphasisMark") {
						ranges.push(replaceDecoration.range(cursor.from, cursor.to));
						if (contentFrom === -1) {
							contentFrom = cursor.to;
						}
						contentTo = cursor.from;
					}
				} while (cursor.nextSibling());

				if (contentFrom !== -1 && contentTo > contentFrom) {
					const markClass = node.name === "StrongEmphasis" ? "cm-strong" : "cm-emphasis";
					ranges.push(Decoration.mark({ class: markClass }).range(contentFrom, contentTo));
				}
			},
		});
	}

	return Decoration.set(ranges, true);
}

class EmphasisDecorationPlugin implements PluginValue {
	decorations: DecorationSet;
	prevCursorLines: Set<number>;

	constructor(view: EditorView) {
		this.decorations = buildDecorations(view);
		this.prevCursorLines = collectCursorLines(view);
	}

	update(update: ViewUpdate) {
		if (update.view.composing) {
			if (update.docChanged) this.decorations = this.decorations.map(update.changes);
			return;
		}
		const forceRebuild =
			update.docChanged ||
			update.viewportChanged ||
			syntaxTree(update.state) !== syntaxTree(update.startState);
		if (forceRebuild) {
			this.decorations = buildDecorations(update.view);
			this.prevCursorLines = collectCursorLines(update.view);
		} else if (update.selectionSet || update.focusChanged) {
			const next = collectCursorLines(update.view);
			if (cursorLinesChanged(this.prevCursorLines, next)) {
				this.prevCursorLines = next;
				this.decorations = buildDecorations(update.view);
			}
		}
	}
}

export const emphasisDecoration = ViewPlugin.fromClass(EmphasisDecorationPlugin, {
	decorations: (v) => v.decorations,
});
