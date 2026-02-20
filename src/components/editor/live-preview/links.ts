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
import { open } from "@tauri-apps/plugin-shell";

const SAFE_URL_RE = /^https?:\/\//i;

export function isSafeUrl(url: string): boolean {
	return SAFE_URL_RE.test(url);
}

class LinkWidget extends WidgetType {
	constructor(
		readonly text: string,
		readonly url: string,
	) {
		super();
	}

	eq(other: LinkWidget): boolean {
		return this.text === other.text && this.url === other.url;
	}

	toDOM(): HTMLElement {
		const anchor = document.createElement("a");
		anchor.className = "cm-link-widget";
		anchor.textContent = this.text;
		anchor.title = this.url;
		if (isSafeUrl(this.url)) {
			anchor.addEventListener("click", (e) => {
				e.preventDefault();
				open(this.url);
			});
		}
		return anchor;
	}

	ignoreEvent(event: Event): boolean {
		return event.type !== "click";
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
				if (node.name !== "Link") return;

				const startLine = state.doc.lineAt(node.from).number;
				const endLine = state.doc.lineAt(node.to).number;
				for (let l = startLine; l <= endLine; l++) {
					if (cursorLines.has(l)) return;
				}

				const cursor = node.node.cursor();
				if (!cursor.firstChild()) return;

				let textFrom = -1;
				let textTo = -1;
				let url = "";
				let foundCloseBracket = false;

				do {
					if (cursor.name === "LinkMark") {
						const markText = state.doc.sliceString(cursor.from, cursor.to);
						if (markText === "[") {
							textFrom = cursor.to;
						} else if (markText === "]" && !foundCloseBracket) {
							textTo = cursor.from;
							foundCloseBracket = true;
						}
					} else if (cursor.name === "URL") {
						url = state.doc.sliceString(cursor.from, cursor.to);
					}
				} while (cursor.nextSibling());

				if (!url || textFrom === -1 || textTo === -1) return;

				const text = state.doc.sliceString(textFrom, textTo);
				ranges.push(
					Decoration.replace({
						widget: new LinkWidget(text, url),
					}).range(node.from, node.to),
				);
			},
		});
	}

	return Decoration.set(ranges, true);
}

class LinkDecorationPlugin implements PluginValue {
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

export const linkDecoration = ViewPlugin.fromClass(LinkDecorationPlugin, {
	decorations: (v) => v.decorations,
	eventHandlers: {
		click: () => {},
	},
});
