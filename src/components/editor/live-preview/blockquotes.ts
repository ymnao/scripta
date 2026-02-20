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

const blockquoteLineDecoration = Decoration.line({
	attributes: { class: "cm-blockquote-line" },
});
const replaceDecoration = Decoration.replace({});

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
				if (node.name !== "Blockquote") return;

				const startLine = state.doc.lineAt(node.from);
				const endLine = state.doc.lineAt(node.to);

				// Skip the entire blockquote if cursor is on any of its lines
				for (let l = startLine.number; l <= endLine.number; l++) {
					if (cursorLines.has(l)) return false;
				}

				// Add line decoration to all lines
				for (let l = startLine.number; l <= endLine.number; l++) {
					const line = state.doc.line(l);
					ranges.push(blockquoteLineDecoration.range(line.from, line.from));
				}

				// Hide all QuoteMarks (and trailing space) within this blockquote
				tree.iterate({
					from: node.from,
					to: node.to,
					enter(child) {
						if (child.name !== "QuoteMark") return;
						let replaceEnd = child.to;
						if (
							replaceEnd < state.doc.length &&
							state.doc.sliceString(replaceEnd, replaceEnd + 1) === " "
						) {
							replaceEnd += 1;
						}
						ranges.push(replaceDecoration.range(child.from, replaceEnd));
					},
				});

				// Prevent processing nested Blockquote nodes again
				return false;
			},
		});
	}

	return Decoration.set(ranges, true);
}

class BlockquoteDecorationPlugin implements PluginValue {
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

export const blockquoteDecoration = ViewPlugin.fromClass(BlockquoteDecorationPlugin, {
	decorations: (v) => v.decorations,
});
