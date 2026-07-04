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

export class HRWidget extends WidgetType {
	eq(_other: WidgetType): boolean {
		return true;
	}

	toDOM(): HTMLElement {
		const hr = document.createElement("hr");
		hr.className = "cm-hr-widget";
		return hr;
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

		// カーソルがフォーカスされた行に HR がある場合は raw `---` のままにする。
		// widget で replace するとカーソル進入時に表示が崩れる（左端の白い点滅）。
		// フォーカス外し時は cursorLines が空なので lineAt 呼び出しごと省略。
		if (cursorLines.size > 0) {
			const lineNumber = state.doc.lineAt(node.from).number;
			if (cursorLines.has(lineNumber)) return;
		}

		ranges.push(
			Decoration.replace({
				widget: new HRWidget(),
			}).range(node.from, node.to),
		);
	});

	return Decoration.set(ranges, true);
}

class HorizontalRuleDecorationPlugin implements PluginValue {
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

export const horizontalRuleDecoration = ViewPlugin.fromClass(HorizontalRuleDecorationPlugin, {
	decorations: (v) => v.decorations,
});
