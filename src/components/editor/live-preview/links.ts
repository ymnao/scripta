import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type Extension, type Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { open } from "@tauri-apps/plugin-shell";
import { collectCursorLines } from "./cursor-utils";

// Only allow http/https URLs without whitespace characters.
// data: URLs are explicitly blocked as defense-in-depth.
const SAFE_URL_RE = /^https?:\/\/[^\s]+$/i;

export function isSafeUrl(url: string): boolean {
	if (/^data:/i.test(url)) return false;
	return SAFE_URL_RE.test(url);
}

export class LinkWidget extends WidgetType {
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
		if (isSafeUrl(this.url)) {
			anchor.title = this.url;
			anchor.tabIndex = 0;
			anchor.setAttribute("role", "link");
			const openUrl = () => {
				open(this.url).catch((error) => {
					console.error("Failed to open external URL:", this.url, error);
				});
			};
			anchor.addEventListener("mousedown", (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				openUrl();
			});
			anchor.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					openUrl();
				}
			});
		} else {
			anchor.className = "cm-link-widget cm-link-widget-disabled";
			anchor.title = `${this.url} (opens only http/https)`;
			anchor.tabIndex = -1;
			anchor.setAttribute("aria-disabled", "true");
		}
		return anchor;
	}

	ignoreEvent(event: Event): boolean {
		// false = ウィジェットが処理（エディタはカーソル移動しない）
		if (event.type === "mousedown" || event.type === "click") return false;
		return true;
	}
}

function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);

	const cursorLines = collectCursorLines(view);

	const ranges: Range<Decoration>[] = [];

	for (const { from, to } of view.visibleRanges) {
		tree.iterate({
			from,
			to,
			enter(node) {
				if (node.name !== "Link") return;

				// Skip Link nodes that are part of a [[wikilink]] pattern
				if (node.from >= 2 && state.doc.sliceString(node.from - 2, node.from) === "[[") {
					// Count consecutive backslashes before "[["
					let bsCount = 0;
					for (let i = node.from - 3; i >= 0; i--) {
						if (state.doc.sliceString(i, i + 1) === "\\") bsCount++;
						else break;
					}
					// Odd backslashes = escaped, so treat as normal link; even = real wikilink
					if (bsCount % 2 === 0) {
						// Also verify closing ]] exists after the Link node
						const suffix = state.doc.sliceString(node.to, node.to + 2);
						if (suffix === "]]") return;
					}
				}

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

				const rawText = state.doc.sliceString(textFrom, textTo);
				const displayText = rawText.trim().length > 0 ? rawText : url;
				ranges.push(
					Decoration.replace({
						widget: new LinkWidget(displayText, url),
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

const linkPlugin = ViewPlugin.fromClass(LinkDecorationPlugin, {
	decorations: (v) => v.decorations,
});

const URL_PASTE_RE = /^https?:\/\/[^\s]+$/i;

const urlPasteHandler = EditorView.domEventHandlers({
	paste(event: ClipboardEvent, view: EditorView) {
		const text = event.clipboardData?.getData("text/plain")?.trim();
		if (!text || !URL_PASTE_RE.test(text)) return false;

		const { state } = view;
		const tree = syntaxTree(state);

		// コードブロック内では変換しない
		for (const range of state.selection.ranges) {
			let node = tree.resolveInner(range.from);
			while (node) {
				if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "InlineCode") {
					return false;
				}
				if (!node.parent) break;
				node = node.parent;
			}
		}

		event.preventDefault();
		const changes = state.changeByRange((range) => {
			const selected = state.doc.sliceString(range.from, range.to);
			const label = selected || text;
			const insert = `[${label}](${text})`;
			return {
				range: EditorSelection.cursor(range.from + insert.length),
				changes: { from: range.from, to: range.to, insert },
			};
		});
		view.dispatch(changes, { userEvent: "input.paste" });
		return true;
	},
});

export const linkDecoration: Extension = [linkPlugin, urlPasteHandler];
