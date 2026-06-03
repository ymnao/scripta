import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type Extension, type Range } from "@codemirror/state";
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
import { collectCursorLines, cursorInRange, cursorLinesChanged } from "./cursor-utils";

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

/** modifier 押下時のみ「開く」操作とみなすかを判定する pure 関数。 */
export function isOpenLinkModifierEvent(event: MouseEvent | KeyboardEvent): boolean {
	// Mac は metaKey (Cmd)、その他 OS は ctrlKey
	return event.metaKey || event.ctrlKey;
}

export class LinkWidget extends WidgetType {
	text: string;
	url: string;
	constructor(text: string, url: string) {
		super();
		this.text = text;
		this.url = url;
	}

	eq(other: LinkWidget): boolean {
		return this.text === other.text && this.url === other.url;
	}

	toDOM(): HTMLElement {
		const anchor = document.createElement("a");
		anchor.className = "cm-link-widget";
		anchor.textContent = this.text;
		if (isSafeUrl(this.url)) {
			// href は accessibility / hover preview (status bar) のため設定。
			// cmd+click の新規ウィンドウ動作は ViewPlugin の mousedown handler
			// で preventDefault することで抑制する。
			anchor.href = this.url;
			anchor.dataset.linkWidgetUrl = this.url;
			const isMac =
				typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
			anchor.title = `${this.url} (${isMac ? "⌘" : "Ctrl"}+クリックで開く)`;
			anchor.tabIndex = 0;
			// マウス系イベントは ViewPlugin.eventHandlers (linkPlugin) が捌くので
			// widget DOM 上には listener を付けない。CodeMirror 公式の
			// "Boolean Toggle Widget" 例 / 本リポジトリの CheckboxWidget と同じ
			// パターン。Cf. https://codemirror.net/examples/decoration/
		} else {
			anchor.className = "cm-link-widget cm-link-widget-disabled";
			anchor.title = `${this.url} (opens only http/https)`;
			anchor.tabIndex = -1;
			anchor.setAttribute("aria-disabled", "true");
		}
		return anchor;
	}

	ignoreEvent(): boolean {
		// false: editor が普通にイベントを処理する → ViewPlugin.eventHandlers が
		// 動く。CheckboxWidget と同じパターン。
		// この方式だと CM6 が selection placement を試みる → plain click は
		// cursor 移動して widget が再 render され raw 表示になる（意図通り）。
		// cmd+click / 右クリックは ViewPlugin handler で preventDefault + 専用処理。
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
	prevCursorLines: Set<number>;

	constructor(view: EditorView) {
		this.decorations = buildDecorations(view);
		this.prevCursorLines = collectCursorLines(view);
	}

	update(update: ViewUpdate) {
		if (update.view.composing) {
			if (update.docChanged) this.decorations = this.decorations.map(update.changes);
			return;
		}
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

const linkPlugin = ViewPlugin.fromClass(LinkDecorationPlugin, {
	decorations: (v) => v.decorations,
	// CodeMirror 公式 "Boolean Toggle Widget" / 本リポジトリの CheckboxWidget と
	// 同じパターン。widget の DOM 上にイベント listener を貼るのではなく、
	// ViewPlugin の eventHandlers として登録することで、イベント順序の foot-gun
	// (ignoreEvent / Prec / built-in selection との競合) を回避する。
	eventHandlers: {
		mousedown(event: MouseEvent, _view) {
			const target = event.target;
			if (!(target instanceof Element)) return false;
			const widgetEl = target.closest<HTMLElement>(".cm-link-widget");
			if (!widgetEl) return false;
			if (widgetEl.classList.contains("cm-link-widget-disabled")) return false;

			// 右クリック (button 2): cursor 移動を阻止して widget を残し、
			// 続く contextmenu event で専用メニューを出す。
			if (event.button === 2) {
				event.preventDefault();
				return true;
			}

			// cmd/ctrl + 左クリック: その場で URL を開く（click event を待つと
			// widget の再 render の race で取り逃すケースがあるため）。
			if (event.button === 0 && isOpenLinkModifierEvent(event)) {
				event.preventDefault();
				const url = widgetEl.dataset.linkWidgetUrl;
				if (url) {
					openExternal(url).catch((error) => {
						console.error("Failed to open external URL:", url, error);
					});
				}
				return true;
			}

			// modifier 無し左クリック: false を返して CM の built-in selection に
			// 処理させる → cursor が行内に入り widget が消えて raw 表示になる。
			return false;
		},

		click(event: MouseEvent, _view) {
			// href 属性を持つので click 既定動作 (navigate) を抑止する。
			// 実際の open は mousedown で行うのでここでは preventDefault のみ。
			const target = event.target;
			if (!(target instanceof Element)) return false;
			const widgetEl = target.closest<HTMLElement>(".cm-link-widget");
			if (!widgetEl) return false;
			if (widgetEl.classList.contains("cm-link-widget-disabled")) return false;
			event.preventDefault();
			return false; // false: CM の他処理は通常通り走らせる
		},

		contextmenu(event: MouseEvent, view) {
			const target = event.target;
			if (!(target instanceof Element)) return false;
			const widgetEl = target.closest<HTMLElement>(".cm-link-widget");
			if (!widgetEl) return false;
			if (widgetEl.classList.contains("cm-link-widget-disabled")) return false;

			const pos = view.posAtDOM(widgetEl);
			const linkRange = findEnclosingLinkNode(view.state, pos);
			if (!linkRange) return false;

			const parts = extractLinkParts(view.state, linkRange.from, linkRange.to);
			if (!parts) return false;

			const line = view.state.doc.lineAt(linkRange.from);
			const lineText = view.state.doc.sliceString(line.from, line.to);
			const isUrlOnlyLine = isLineOnlyMdLink(
				lineText,
				line.from,
				linkRange.from,
				linkRange.to,
				line.to,
			);

			event.preventDefault();
			view.dom.dispatchEvent(
				new CustomEvent("link-widget-context-menu", {
					bubbles: true,
					detail: {
						url: parts.url,
						label: parts.label,
						from: linkRange.from,
						to: linkRange.to,
						isUrlOnlyLine,
						clientX: event.clientX,
						clientY: event.clientY,
					},
				}),
			);
			return true;
		},

		keydown(event: KeyboardEvent, _view) {
			// Tab focus 中の Enter/Space で URL を開く
			if (event.key !== "Enter" && event.key !== " ") return false;
			const target = event.target;
			if (!(target instanceof Element)) return false;
			const widgetEl = target.closest<HTMLElement>(".cm-link-widget");
			if (!widgetEl) return false;
			if (widgetEl.classList.contains("cm-link-widget-disabled")) return false;
			const url = widgetEl.dataset.linkWidgetUrl;
			if (!url) return false;
			event.preventDefault();
			event.stopPropagation();
			openExternal(url).catch((error) => {
				console.error("Failed to open external URL:", url, error);
			});
			return true;
		},
	},
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

/**
 * URL paste 時に md リンクへ変換すべきかを判定する pure 関数。
 *
 * 選択ありなら常に変換（ラップ）。選択なしの場合は paste 後の行が
 * URL のみになるなら plain insert（link-cards が OGP card を起動）、
 * 他テキストが混在するなら変換する。
 *
 * #96: link-cards の OGP card は行全体が URL の時のみ起動するため、
 * URL only 行への paste で md リンクに変換すると card が出ない。
 */
export function shouldConvertPasteToLink(opts: {
	hasSelection: boolean;
	lineBefore: string;
	lineAfter: string;
}): boolean {
	if (opts.hasSelection) return true;
	return opts.lineBefore.trim() !== "" || opts.lineAfter.trim() !== "";
}

/**
 * 指定位置がコードブロック（fenced / indented / inline）の中かを判定する。
 * URL paste のときに md リンク変換を抑制するために使う。
 */
export function isPosInCodeConstruct(state: EditorState, pos: number): boolean {
	const tree = syntaxTree(state);
	let node = tree.resolveInner(pos);
	while (node) {
		if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "InlineCode") {
			return true;
		}
		if (!node.parent) break;
		node = node.parent;
	}
	return false;
}

/** selection の少なくとも一つの range がコード構造内にあるか。 */
export function anyRangeInCodeConstruct(state: EditorState): boolean {
	for (const range of state.selection.ranges) {
		if (isPosInCodeConstruct(state, range.from)) return true;
	}
	return false;
}

/**
 * URL を 1 range に挿入するときの insert 文字列を決定する pure 関数。
 *
 * - `inCodeBlock` → 常に plain（コード内では md syntax を入れない）
 * - `forceConvert` (Cmd+Shift+V 用) → 行コンテキストに関係なく md リンク化
 * - それ以外は shouldConvertPasteToLink の判定に従う
 */
export function computeUrlPasteInsert(opts: {
	text: string;
	forceConvert: boolean;
	inCodeBlock: boolean;
	hasSelection: boolean;
	selectedText: string;
	lineBefore: string;
	lineAfter: string;
}): string {
	if (opts.inCodeBlock) return opts.text;
	const convert =
		opts.forceConvert ||
		shouldConvertPasteToLink({
			hasSelection: opts.hasSelection,
			lineBefore: opts.lineBefore,
			lineAfter: opts.lineAfter,
		});
	return convert ? buildMarkdownLink(opts.text, opts.selectedText) : opts.text;
}

/**
 * URL を全 selection range に dispatch する共通実装。
 * Cmd+V 系の paste handler / Cmd+Shift+V のコマンドの両方から呼ぶ。
 */
function dispatchUrlInsert(view: EditorView, text: string, forceConvert: boolean): void {
	const { state } = view;
	const inCode = anyRangeInCodeConstruct(state);
	const changes = state.changeByRange((range) => {
		const hasSelection = range.from !== range.to;
		const selectedText = state.doc.sliceString(range.from, range.to);
		const line = state.doc.lineAt(range.from);
		const lineBefore = state.doc.sliceString(line.from, range.from);
		const lineAfter = state.doc.sliceString(range.to, line.to);
		const insert = computeUrlPasteInsert({
			text,
			forceConvert,
			inCodeBlock: inCode,
			hasSelection,
			selectedText,
			lineBefore,
			lineAfter,
		});
		return {
			range: EditorSelection.cursor(range.from + insert.length),
			changes: { from: range.from, to: range.to, insert },
		};
	});
	view.dispatch({ ...changes, userEvent: "input.paste" });
}

const urlPasteHandler = EditorView.domEventHandlers({
	paste(event: ClipboardEvent, view: EditorView) {
		const text = event.clipboardData?.getData("text/plain")?.trim();
		if (!text || !URL_PASTE_RE.test(text)) return false;

		// コードブロック内では browser 既定 (plain paste) に委ねる
		if (anyRangeInCodeConstruct(view.state)) return false;

		event.preventDefault();
		dispatchUrlInsert(view, text, /* forceConvert */ false);
		return true;
	},
});

/**
 * Cmd+Shift+V で clipboard を読み終えた後に走る同期ロジック。
 * テスタビリティのため `pasteAsMarkdownLinkCommand` から切り出している。
 *
 * - URL なら強制的に md リンク化（selection あれば label に）
 * - 非 URL なら plain text として挿入
 * - コードブロック内なら常に plain
 */
export function applyClipboardPasteAsMdLink(view: EditorView, raw: string | null): void {
	const text = raw?.trim() ?? "";
	if (!text) return;
	if (!URL_PASTE_RE.test(text)) {
		// 非 URL は plain insert（selection あれば置換）
		const { state } = view;
		const changes = state.changeByRange((range) => ({
			range: EditorSelection.cursor(range.from + text.length),
			changes: { from: range.from, to: range.to, insert: text },
		}));
		view.dispatch({ ...changes, userEvent: "input.paste" });
		return;
	}
	dispatchUrlInsert(view, text, /* forceConvert */ true);
}

/**
 * Cmd+Shift+V 用のコマンド。clipboard を非同期で読み、結果を
 * `applyClipboardPasteAsMdLink` に渡す。
 *
 * `navigator.clipboard.readText()` は async だが、CodeMirror のコマンドは
 * 同期で boolean を返す必要があるため fire-and-forget。clipboard アクセスが
 * できる時点（keydown 由来）で true を返してデフォルトの paste-and-match-style
 * を抑制する。
 */
export function pasteAsMarkdownLinkCommand(view: EditorView): boolean {
	if (!navigator.clipboard) return false;
	navigator.clipboard.readText().then(
		(raw) => applyClipboardPasteAsMdLink(view, raw),
		() => {
			// clipboard アクセス拒否時は何もしない
		},
	);
	return true;
}

/**
 * `[label](<url>)` または `[label](url)` 形式の md リンクを pure に parse する。
 *
 * 右クリック「カードにする」判定で「行が md リンクのみ」を確認するために使う。
 * Lezer 経由でも同じ情報は取れるが、テスタビリティと依存削減のため再実装。
 *
 * 厳密な CommonMark parser ではなく、よくある形のみ受け付ける（escape は最小限）。
 */
export function parseSingleMdLink(
	source: string,
): { label: string; url: string; from: number; to: number } | null {
	// `[label](<url>)` or `[label](url)` を見つける。
	// label 内は \] / \\ をサポート（buildMarkdownLink と対称）。
	// plain 形 `(url)` は `<` で始まるものを除外（angle 形 `(<url>)` と区別する）
	const re = /\[((?:\\.|[^\]\\])*)\](?:\(<([^>]+)>\)|\((?!<)([^)\s]+)\))/;
	const m = re.exec(source);
	if (!m) return null;
	const label = m[1].replace(/\\(.)/g, "$1");
	const url = m[2] ?? m[3];
	if (!url) return null;
	return { label, url, from: m.index, to: m.index + m[0].length };
}

/**
 * `[link](<url>)` の md リンクを含む CM Link node から URL と label の range を取り出す。
 * `links.ts` の buildDecorations と同じロジックを再利用。
 */
function extractLinkParts(
	state: EditorState,
	linkFrom: number,
	linkTo: number,
): { url: string; label: string } | null {
	const tree = syntaxTree(state);
	let linkNode = tree.resolveInner(linkFrom, 1);
	while (linkNode && linkNode.name !== "Link") {
		if (!linkNode.parent) return null;
		linkNode = linkNode.parent;
	}
	if (!linkNode || linkNode.from !== linkFrom || linkNode.to !== linkTo) return null;
	const cursor = linkNode.cursor();
	if (!cursor.firstChild()) return null;
	let textFrom = -1;
	let textTo = -1;
	let url = "";
	let foundCloseBracket = false;
	do {
		if (cursor.name === "LinkMark") {
			const markText = state.doc.sliceString(cursor.from, cursor.to);
			if (markText === "[") textFrom = cursor.to;
			else if (markText === "]" && !foundCloseBracket) {
				textTo = cursor.from;
				foundCloseBracket = true;
			}
		} else if (cursor.name === "URL") {
			url = state.doc.sliceString(cursor.from, cursor.to);
		}
	} while (cursor.nextSibling());
	if (!url || textFrom < 0 || textTo < 0) return null;
	return { url, label: state.doc.sliceString(textFrom, textTo) };
}

/**
 * 行内に md リンク以外のテキストが無い（前後 trim で空）かを判定する pure 関数。
 * 右クリック「カードにする」をメニューに出す条件。
 */
export function isLineOnlyMdLink(
	lineText: string,
	lineFrom: number,
	linkFrom: number,
	linkTo: number,
	lineTo: number,
): boolean {
	const before = lineText.slice(0, linkFrom - lineFrom).trim();
	const after = lineText.slice(linkTo - lineFrom, lineTo - lineFrom).trim();
	return before === "" && after === "";
}

/** Walk up from `pos` until a Link node is found; return null if none. */
function findEnclosingLinkNode(
	state: EditorState,
	pos: number,
): { from: number; to: number } | null {
	const tree = syntaxTree(state);
	let node = tree.resolveInner(pos, 1);
	while (node && node.name !== "Link") {
		if (!node.parent) return null;
		node = node.parent;
	}
	return node ? { from: node.from, to: node.to } : null;
}

export const linkDecoration: Extension = [linkPlugin, urlPasteHandler];
