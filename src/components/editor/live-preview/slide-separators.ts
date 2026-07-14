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
import { collectCursorLines, cursorLinesChanged } from "./cursor-utils";
import { handleComposingUpdate, iterateVisibleSyntax } from "./plugin-utils";

/**
 * スライドモード用の区切り widget。`---` を通常の細い HR ではなく、
 * 太めの破線 + アクセントカラーでスライド境界であることを視覚的に強調する。
 */
export class SlideSeparatorWidget extends WidgetType {
	eq(_other: WidgetType): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const div = document.createElement("div");
		div.className = "cm-slide-separator-widget";
		div.setAttribute("aria-label", "スライド区切り");
		return div;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

export function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const cursorLines = collectCursorLines(view);
	const ranges: Range<Decoration>[] = [];

	iterateVisibleSyntax(view, (node) => {
		if (node.name !== "HorizontalRule") return;

		// horizontal-rules.ts と同じく、カーソル進入時は raw `---` を残す。
		if (cursorLines.size > 0) {
			const lineNumber = state.doc.lineAt(node.from).number;
			if (cursorLines.has(lineNumber)) return;
		}

		ranges.push(
			Decoration.replace({
				widget: new SlideSeparatorWidget(),
			}).range(node.from, node.to),
		);
	});

	return Decoration.set(ranges, true);
}

class SlideSeparatorDecorationPlugin implements PluginValue {
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

export const slideSeparatorDecoration = ViewPlugin.fromClass(SlideSeparatorDecorationPlugin, {
	decorations: (v) => v.decorations,
});
