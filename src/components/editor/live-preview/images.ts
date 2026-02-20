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
import { convertFileSrc } from "@tauri-apps/api/core";
import { useWorkspaceStore } from "../../../stores/workspace";

export function parentDir(filePath: string): string {
	const lastSep = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
	if (lastSep === -1) return "";
	if (lastSep === 0) return filePath[0];
	return filePath.substring(0, lastSep);
}

function detectSeparator(filePath: string): string {
	const lastSlash = filePath.lastIndexOf("/");
	const lastBackslash = filePath.lastIndexOf("\\");
	if (lastSlash === -1 && lastBackslash === -1) return "/";
	return lastBackslash > lastSlash ? "\\" : "/";
}

export function resolveImageSrc(
	rawUrl: string,
	activeTabPath: string | null = useWorkspaceStore.getState().activeTabPath,
): string {
	if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
		return rawUrl;
	}
	if (rawUrl.startsWith("/") || rawUrl.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(rawUrl)) {
		return convertFileSrc(rawUrl);
	}
	if (!activeTabPath) return rawUrl;
	const dir = parentDir(activeTabPath);
	if (!dir) return rawUrl;
	let normalized = rawUrl;
	if (normalized.startsWith("./") || normalized.startsWith(".\\")) {
		normalized = normalized.slice(2);
	}
	const sep = detectSeparator(activeTabPath);
	const needsSep = !dir.endsWith("/") && !dir.endsWith("\\");
	const resolved = needsSep ? `${dir}${sep}${normalized}` : `${dir}${normalized}`;
	return convertFileSrc(resolved);
}

class ImageWidget extends WidgetType {
	constructor(
		readonly src: string,
		readonly alt: string,
	) {
		super();
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
				if (node.name !== "Image") return;

				const startLine = state.doc.lineAt(node.from).number;
				const endLine = state.doc.lineAt(node.to).number;
				for (let l = startLine; l <= endLine; l++) {
					if (cursorLines.has(l)) return;
				}

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
			},
		});
	}

	return Decoration.set(ranges, true);
}

class ImageDecorationPlugin implements PluginValue {
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

export const imageDecoration = ViewPlugin.fromClass(ImageDecorationPlugin, {
	decorations: (v) => v.decorations,
});
