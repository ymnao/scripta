import { WidgetType } from "@codemirror/view";
import { createHrReplaceDecoration } from "./plugin-utils";

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

const slideDecoration = createHrReplaceDecoration(() => new SlideSeparatorWidget());

export const { buildDecorations } = slideDecoration;
export const slideSeparatorDecoration = slideDecoration.extension;
