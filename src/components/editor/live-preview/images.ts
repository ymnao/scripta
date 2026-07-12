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
import { resolveImageSrc } from "../../../lib/image-src";
import { collectCursorLines, cursorInRange, cursorLinesChanged } from "./cursor-utils";
import { handleComposingUpdate, iterateVisibleSyntax } from "./plugin-utils";

class ImageWidget extends WidgetType {
	src: string;
	alt: string;
	constructor(src: string, alt: string) {
		super();
		this.src = src;
		this.alt = alt;
	}

	eq(other: ImageWidget): boolean {
		return this.src === other.src && this.alt === other.alt;
	}

	toDOM(): HTMLElement {
		const wrapper = document.createElement("span");
		wrapper.className = "cm-image-widget";

		const img = document.createElement("img");
		img.src = resolveImageSrc(this.src);
		img.alt = this.alt;
		img.addEventListener(
			"error",
			() => {
				img.remove();
				const fallback = document.createElement("span");
				fallback.className = "cm-image-fallback";
				fallback.textContent = `[Image: ${this.alt}]`;
				wrapper.appendChild(fallback);
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

function buildDecorations(view: EditorView): DecorationSet {
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
				widget: new ImageWidget(url, alt),
			}).range(node.from, node.to),
		);
	});

	return Decoration.set(ranges, true);
}

class ImageDecorationPlugin implements PluginValue {
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

export const imageDecoration = ViewPlugin.fromClass(ImageDecorationPlugin, {
	decorations: (v) => v.decorations,
});
