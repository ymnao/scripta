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

const codeBlockLineDecoration = Decoration.line({
	attributes: { class: "cm-codeblock-line" },
});

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
				if (node.name !== "FencedCode") return;

				const startLine = state.doc.lineAt(node.from);
				const endLine = state.doc.lineAt(node.to);

				// Skip the entire code block if cursor is on any of its lines
				for (let l = startLine.number; l <= endLine.number; l++) {
					if (cursorLines.has(l)) return;
				}

				// Add background line decoration to all lines (including fence lines)
				for (let l = startLine.number; l <= endLine.number; l++) {
					const line = state.doc.line(l);
					ranges.push(codeBlockLineDecoration.range(line.from, line.from));
				}
			},
		});
	}

	return Decoration.set(ranges, true);
}

class CodeBlockDecorationPlugin implements PluginValue {
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

export const codeBlockDecoration = ViewPlugin.fromClass(CodeBlockDecorationPlugin, {
	decorations: (v) => v.decorations,
});
