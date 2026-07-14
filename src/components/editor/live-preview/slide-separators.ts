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

// parseSlides (src/lib/slide-parser.ts) がスライドを分割する条件と揃えて `---`
// のみを装飾対象にする。lezer の HorizontalRule は `***` / `___` / `-----` 等
// も含むが、それらでスライドは切れないため装飾すると認識ズレが起きる。
const slideDecoration = createHrReplaceDecoration(
	() => new SlideSeparatorWidget(),
	(trimmed) => trimmed === "---",
);

export const { buildDecorations } = slideDecoration;
export const slideSeparatorDecoration = slideDecoration.extension;
