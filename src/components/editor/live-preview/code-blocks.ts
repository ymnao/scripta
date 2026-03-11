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
import { collectCursorLines } from "./cursor-utils";

const codeBlockLineDecoration = Decoration.line({
	attributes: { class: "cm-codeblock-line" },
});
const replaceDecoration = Decoration.replace({});

const MERMAID_FENCE_RE = /^`{3,}\s*mermaid\s*$/;

export function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);

	const cursorLines = collectCursorLines(view);

	const ranges: Range<Decoration>[] = [];

	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter(node) {
				if (node.name !== "FencedCode") return;

				const startLine = state.doc.lineAt(node.from);
				const endLine = state.doc.lineAt(node.to);

				// Skip mermaid blocks when cursor is outside — handled by mermaid decoration
				if (MERMAID_FENCE_RE.test(startLine.text.trim())) {
					let cursorInBlock = false;
					for (let l = startLine.number; l <= endLine.number; l++) {
						if (cursorLines.has(l)) {
							cursorInBlock = true;
							break;
						}
					}
					if (!cursorInBlock) return;
				}

				// Clamp decoration target lines to the current visible range
				const visibleStartLine = state.doc.lineAt(from);
				const visibleEndLine = state.doc.lineAt(to);
				const fromLineNumber = Math.max(startLine.number, visibleStartLine.number);
				const toLineNumber = Math.min(endLine.number, visibleEndLine.number);
				if (fromLineNumber > toLineNumber) return;

				// Hide fence lines only when cursor is not on them
				if (!cursorLines.has(startLine.number) && startLine.from < startLine.to) {
					ranges.push(replaceDecoration.range(startLine.from, startLine.to));
				}
				if (
					endLine.number !== startLine.number &&
					!cursorLines.has(endLine.number) &&
					endLine.from < endLine.to
				) {
					ranges.push(replaceDecoration.range(endLine.from, endLine.to));
				}

				// Add background line decoration only to the visible intersection
				for (let l = fromLineNumber; l <= toLineNumber; l++) {
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
		if (update.view.composing) {
			if (update.docChanged) this.decorations = this.decorations.map(update.changes);
			return;
		}
		if (
			update.docChanged ||
			update.viewportChanged ||
			update.selectionSet ||
			update.focusChanged ||
			syntaxTree(update.state) !== syntaxTree(update.startState)
		) {
			this.decorations = buildDecorations(update.view);
		}
	}
}

export const codeBlockDecoration = ViewPlugin.fromClass(CodeBlockDecorationPlugin, {
	decorations: (v) => v.decorations,
});
