import { syntaxTree } from "@codemirror/language";
import { type Range, StateEffect } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	type EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { resolveImageSrc } from "../../../lib/image-src";
import { collectCursorLines, cursorInRange, cursorLinesChanged } from "./cursor-utils";
import { handleComposingUpdate, iterateVisibleSyntax } from "./plugin-utils";

// 読み込み・失敗で行の高さが変わっても、CM6 は widget 内の変化を見ないので height map が
// 古いまま残り、クリックが別の行に解決される (#698)。requestMeasure では足りない: 文書が
// 短く .cm-content が min-height: 100% に張り付いていると、CM6 は高さの変化に気付かず
// 行を測り直さない。装飾を作り直すと CM6 は行を測り直す
const imageSizeChanged = StateEffect.define<null>();

class ImageWidget extends WidgetType {
	src: string;
	alt: string;
	generation: number;
	constructor(src: string, alt: string, generation: number) {
		super();
		this.src = src;
		this.alt = alt;
		this.generation = generation;
	}

	eq(other: ImageWidget): boolean {
		return this.src === other.src && this.alt === other.alt && this.generation === other.generation;
	}

	// generation だけが違うなら DOM を使い回す。作り直すと読み込みがまた走り、再構築が止まらない
	updateDOM(_dom: HTMLElement, _view: EditorView, from: ImageWidget): boolean {
		return this.src === from.src && this.alt === from.alt;
	}

	toDOM(view: EditorView): HTMLElement {
		const wrapper = document.createElement("span");
		wrapper.className = "cm-image-widget";

		const notifySizeChanged = () => {
			if (wrapper.isConnected) view.dispatch({ effects: imageSizeChanged.of(null) });
		};
		const img = document.createElement("img");
		img.src = resolveImageSrc(this.src);
		img.alt = this.alt;
		img.addEventListener("load", notifySizeChanged, { once: true });
		img.addEventListener(
			"error",
			() => {
				img.remove();
				const fallback = document.createElement("span");
				fallback.className = "cm-image-fallback";
				fallback.textContent = `[Image: ${this.alt}]`;
				wrapper.appendChild(fallback);
				notifySizeChanged();
			},
			{ once: true },
		);

		wrapper.appendChild(img);
		return wrapper;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function buildDecorations(view: EditorView, generation: number): DecorationSet {
	const { state } = view;
	const cursorLines = collectCursorLines(view);
	const ranges: Range<Decoration>[] = [];

	iterateVisibleSyntax(view, (node) => {
		if (node.name !== "Image") return;

		const startLine = state.doc.lineAt(node.from).number;
		const endLine = state.doc.lineAt(node.to).number;
		if (cursorInRange(cursorLines, startLine, endLine)) return;

		const cursor = node.node.cursor();
		let url = "";
		let altFrom = -1;
		let altTo = -1;
		let foundOpenBracket = false;

		if (cursor.firstChild()) {
			do {
				if (cursor.name === "LinkMark") {
					const markText = state.doc.sliceString(cursor.from, cursor.to);
					if ((markText === "[" || markText === "![") && !foundOpenBracket) {
						altFrom = cursor.to;
						foundOpenBracket = true;
					} else if (markText === "]" && altTo === -1) {
						altTo = cursor.from;
					}
				} else if (cursor.name === "URL") {
					url = state.doc.sliceString(cursor.from, cursor.to);
				}
			} while (cursor.nextSibling());
		}

		if (!url || altFrom === -1 || altTo === -1) return;

		const alt = state.doc.sliceString(altFrom, altTo);
		ranges.push(
			Decoration.replace({
				widget: new ImageWidget(url, alt, generation),
			}).range(node.from, node.to),
		);
	});

	return Decoration.set(ranges, true);
}

class ImageDecorationPlugin implements PluginValue {
	decorations: DecorationSet;
	prevCursorLines: Set<number>;
	generation = 0;

	constructor(view: EditorView) {
		this.decorations = buildDecorations(view, this.generation);
		this.prevCursorLines = collectCursorLines(view);
	}

	update(update: ViewUpdate) {
		if (handleComposingUpdate(update, this)) return;
		const sizeChanged = update.transactions.some((tr) =>
			tr.effects.some((e) => e.is(imageSizeChanged)),
		);
		if (sizeChanged) this.generation++;
		const forceRebuild =
			sizeChanged ||
			update.docChanged ||
			update.viewportChanged ||
			syntaxTree(update.state) !== syntaxTree(update.startState);
		if (forceRebuild) {
			this.decorations = buildDecorations(update.view, this.generation);
			this.prevCursorLines = collectCursorLines(update.view);
		} else if (update.selectionSet || update.focusChanged) {
			const next = collectCursorLines(update.view);
			if (cursorLinesChanged(this.prevCursorLines, next)) {
				this.prevCursorLines = next;
				this.decorations = buildDecorations(update.view, this.generation);
			}
		}
	}
}

export const imageDecoration = ViewPlugin.fromClass(ImageDecorationPlugin, {
	decorations: (v) => v.decorations,
});
