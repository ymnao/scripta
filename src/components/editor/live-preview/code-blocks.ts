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
import { handleComposingUpdate, iterateVisibleSyntax } from "./plugin-utils";

const codeBlockLineDecoration = Decoration.line({
	attributes: { class: "cm-codeblock-line" },
});
const hiddenFenceLineDecoration = Decoration.line({
	attributes: { class: "cm-codeblock-fence-hidden" },
});
const replaceDecoration = Decoration.replace({});

export const MERMAID_FENCE_RE = /^`{3,}\s*mermaid\s*$/;

export function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const cursorLines = collectCursorLines(view);
	const ranges: Range<Decoration>[] = [];

	iterateVisibleSyntax(view, (node, { from, to }) => {
		if (node.name !== "FencedCode") return;

		const startLine = state.doc.lineAt(node.from);
		const endLine = state.doc.lineAt(node.to);

		// Skip mermaid blocks when cursor is outside — handled by mermaid decoration
		if (MERMAID_FENCE_RE.test(startLine.text.trim())) {
			if (!cursorInRange(cursorLines, startLine.number, endLine.number)) return;
		}

		// Clamp decoration target lines to the current visible range
		const visibleStartLine = state.doc.lineAt(from);
		const visibleEndLine = state.doc.lineAt(to);
		const fromLineNumber = Math.max(startLine.number, visibleStartLine.number);
		const toLineNumber = Math.min(endLine.number, visibleEndLine.number);
		if (fromLineNumber > toLineNumber) return;

		// Hide fence lines only when cursor is not on them.
		// Decoration.replace hides only the text; the .cm-line keeps a full line height,
		// so the hidden-fence class lets the theme collapse it to a small padding.
		if (!cursorLines.has(startLine.number) && startLine.from < startLine.to) {
			ranges.push(replaceDecoration.range(startLine.from, startLine.to));
			ranges.push(hiddenFenceLineDecoration.range(startLine.from, startLine.from));
		}
		// 閉じていないブロックでは endLine が本文行なので、隠さない
		const lastMark = node.node.lastChild;
		const hasClosingFence =
			endLine.number !== startLine.number &&
			lastMark?.name === "CodeMark" &&
			lastMark.from >= endLine.from;
		if (hasClosingFence && !cursorLines.has(endLine.number)) {
			ranges.push(replaceDecoration.range(endLine.from, endLine.to));
			ranges.push(hiddenFenceLineDecoration.range(endLine.from, endLine.from));
		}

		// Add background line decoration only to the visible intersection
		for (let l = fromLineNumber; l <= toLineNumber; l++) {
			const line = state.doc.line(l);
			ranges.push(codeBlockLineDecoration.range(line.from, line.from));
		}
	});

	return Decoration.set(ranges, true);
}

class CodeBlockDecorationPlugin implements PluginValue {
	decorations: DecorationSet;
	prevCursorLines: Set<number>;

	constructor(view: EditorView) {
		this.decorations = buildDecorations(view);
		this.prevCursorLines = collectCursorLines(view);
	}

	update(update: ViewUpdate) {
		if (handleComposingUpdate(update, this)) return;
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

export const codeBlockDecoration = ViewPlugin.fromClass(CodeBlockDecorationPlugin, {
	decorations: (v) => v.decorations,
});
