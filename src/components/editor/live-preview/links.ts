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
import { openExternal } from "../../../lib/commands";
import { collectCursorLines, cursorInRange } from "./cursor-utils";

// Only allow http/https URLs without whitespace characters.
// data: URLs are explicitly blocked as defense-in-depth.
const SAFE_URL_RE = /^https?:\/\/[^\s]+$/i;

export function isSafeUrl(url: string): boolean {
	if (/^data:/i.test(url)) return false;
	return SAFE_URL_RE.test(url);
}

/**
 * hostname がプライベート/ループバック/リンクローカルなど
 * WebView から直接アクセスさせたくないアドレスかどうかを判定する。
 *
 * DNS 解決は行わないため、ホスト名ベースで判定できる範囲のみ扱う。
 * nip.io 等の名前解決結果がプライベート IP になるケースは
 * バックエンド側の SsrfSafeResolver で検証する。
 */
export function isPrivateHostname(hostname: string): boolean {
	const lower = hostname.toLowerCase();

	if (!lower || lower === "localhost" || lower === "localhost." || lower.endsWith(".localhost")) {
		return true;
	}

	// IPv6 形式（コロンを含む）はすべて拒否
	// ::1, fe80::1, ::ffff:127.0.0.1 等
	if (lower.includes(":")) return true;

	// 数値 IPv4 リテラル判定
	const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
	if (!ipv4Match) {
		// 通常のドメイン名はここでは拒否しない
		return false;
	}

	const octets = ipv4Match.slice(1).map(Number);
	if (octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return true;

	const [o1, o2] = octets;
	if (o1 === 0) return true; // 0.0.0.0/8
	if (o1 === 127) return true; // 127.0.0.0/8
	if (o1 === 10) return true; // 10.0.0.0/8
	if (o1 === 169 && o2 === 254) return true; // 169.254.0.0/16
	if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // 172.16.0.0/12
	if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16
	if (o1 === 100 && o2 >= 64 && o2 <= 127) return true; // 100.64.0.0/10 (CGNAT)
	if (o1 >= 224) return true; // 224.0.0.0+ (multicast/reserved)

	return false;
}

/** isSafeUrl + rejects private/loopback hosts (for use with image src). */
export function isSafeImageUrl(url: string): boolean {
	if (!isSafeUrl(url)) return false;
	try {
		const hostname = new URL(url).hostname;
		return !isPrivateHostname(hostname);
	} catch {
		return false;
	}
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
			anchor.href = this.url;
			anchor.title = this.url;
			anchor.tabIndex = 0;
			const openUrl = () => {
				openExternal(this.url).catch((error) => {
					console.error("Failed to open external URL:", this.url, error);
				});
			};
			anchor.addEventListener("click", (e) => {
				e.preventDefault();
				if (e.button !== 0) return;
				openUrl();
			});
			anchor.addEventListener("mousedown", (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
			});
			anchor.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					e.stopPropagation();
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
		// 安全な URL のときだけマウスイベントをウィジェット側で処理し、
		// 無効リンクの場合はエディタ側に処理させてカーソル移動等を可能にする
		if ((event.type === "mousedown" || event.type === "click") && isSafeUrl(this.url)) {
			return true;
		}
		return false;
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
				if (cursorInRange(cursorLines, startLine, endLine)) return;

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

export const URL_PASTE_RE = /^https?:\/\/[^\s]+$/i;

/** Escape label text for safe use inside Markdown link brackets. */
export function escapeMarkdownLabel(label: string): string {
	return label.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** Build a Markdown link from a pasted URL and optional selected text. */
export function buildMarkdownLink(url: string, selectedText: string): string {
	const rawLabel = selectedText || url;
	const label = escapeMarkdownLabel(rawLabel);
	// angle bracket で URL を囲み、URL 内の ')' 等でリンクが壊れないようにする
	return `[${label}](<${url}>)`;
}

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
			const insert = buildMarkdownLink(text, selected);
			return {
				range: EditorSelection.cursor(range.from + insert.length),
				changes: { from: range.from, to: range.to, insert },
			};
		});
		view.dispatch({ ...changes, userEvent: "input.paste" });
		return true;
	},
});

export const linkDecoration: Extension = [linkPlugin, urlPasteHandler];
