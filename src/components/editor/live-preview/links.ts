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
import { IS_MAC, PRIMARY_MOD_SYMBOL } from "../../../lib/platform";
import { collectCursorLines, cursorInRange, cursorLinesChanged } from "./cursor-utils";

// http/https のみ、whitespace 不可。
// `isSafeUrl` / `urlPasteHandler` / `link-cards.ts isStandaloneUrlLine` の
// 3 箇所で同じ正規表現が必要なので 1 つだけ宣言して使い回す。
export const URL_PASTE_RE = /^https?:\/\/[^\s]+$/i;

export function isSafeUrl(url: string): boolean {
	// data: URLs は defense-in-depth で明示拒否（URL_PASTE_RE でも弾けるが念のため）
	if (/^data:/i.test(url)) return false;
	return URL_PASTE_RE.test(url);
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

/**
 * 「リンクを開く」操作とみなす modifier 押下判定 (pure 版)。
 * - macOS: Cmd (metaKey) のみ。Ctrl+click は context menu 操作なので除外する
 * - その他 OS: Ctrl (ctrlKey) のみ
 *
 * `isMac` を引数で受けることで OS 依存ロジックをテスト可能にする。
 */
export function decideOpenLinkModifier(
	event: { metaKey: boolean; ctrlKey: boolean },
	isMac: boolean,
): boolean {
	return isMac ? event.metaKey : event.ctrlKey;
}

/** runtime 用: OS を自動判定。 */
export function isOpenLinkModifierEvent(event: MouseEvent | KeyboardEvent): boolean {
	return decideOpenLinkModifier(event, IS_MAC);
}

/**
 * keydown / keyup の `event.key` が「リンクを開く modifier」かを判定 (pure 版)。
 * macOS は "Meta" のみ、非 Mac は "Control" のみ。
 */
export function decideOpenLinkModifierKey(key: string, isMac: boolean): boolean {
	return isMac ? key === "Meta" : key === "Control";
}

/** runtime 用: OS を自動判定。 */
export function isOpenLinkModifierKey(key: string): boolean {
	return decideOpenLinkModifierKey(key, IS_MAC);
}

/** ViewPlugin handler / widget keydown 両方から呼ばれる共通の URL open helper。 */
function openLinkWidgetUrl(url: string): void {
	openExternal(url).catch((error) => {
		console.error("Failed to open external URL:", url, error);
	});
}

/**
 * Lezer markdown parser の URL ノードに含まれる `<>` を剥がす。
 *
 * CommonMark の `[label](<url>)` 形式では Lezer は URL ノードに angle bracket
 * を含めて返す（例: `<https://example.com>`）。剥がさないと `isSafeUrl` の
 * 正規表現 `/^https?:\/\/.../` が外れて widget が disabled 扱いになり、
 * cmd+click / 右クリック handler が早期 return する。
 *
 * `buildMarkdownLink` は angle bracket 形で md リンクを生成するので、paste /
 * Cmd+Shift+V 経由のリンクは全部この罠にハマる（過去にずっと再現していた
 * cmd+click が効かない問題の真因）。
 */
export function stripUrlAngleBrackets(rawUrl: string): string {
	if (rawUrl.startsWith("<") && rawUrl.endsWith(">")) {
		return rawUrl.slice(1, -1);
	}
	return rawUrl;
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
			anchor.title = `${this.url} (${PRIMARY_MOD_SYMBOL}クリックで開く)`;
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

// `@lezer/common` は直接 dependency ではないので、Lezer node / cursor 型を
// structural にローカル定義する（必要な API だけ拾う）。
type LinkNodeCursor = {
	name: string;
	from: number;
	to: number;
	firstChild(): boolean;
	nextSibling(): boolean;
};
type LinkSyntaxNode = { cursor(): LinkNodeCursor };

/**
 * Lezer の Link node から `[label](url)` の構成要素を取り出す pure helper。
 * `buildDecorations` (decoration build) と `resolveLinkAtPos` (contextmenu) の
 * 両方から呼ぶ単一の真実源。URL の angle bracket 剥がしもここで実施する。
 */
function parseLinkNode(
	state: EditorState,
	linkNode: LinkSyntaxNode,
): { url: string; label: string; textFrom: number; textTo: number } | null {
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
			url = stripUrlAngleBrackets(state.doc.sliceString(cursor.from, cursor.to));
		}
		// 必要な 3 要素が揃ったら以降の sibling を見る必要は無い
		if (url && foundCloseBracket && textFrom >= 0) break;
	} while (cursor.nextSibling());
	if (!url || textFrom < 0 || textTo < 0) return null;
	return { url, label: state.doc.sliceString(textFrom, textTo), textFrom, textTo };
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

				// SyntaxNodeRef (iterate callback) → SyntaxNode via `.node`
				const parts = parseLinkNode(state, node.node);
				if (!parts) return;

				const displayText = parts.label.trim().length > 0 ? parts.label : parts.url;
				ranges.push(
					Decoration.replace({
						widget: new LinkWidget(displayText, parts.url),
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
				if (url) openLinkWidgetUrl(url);
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

			const link = resolveLinkAtPos(view.state, view.posAtDOM(widgetEl));
			if (!link) return false;

			const line = view.state.doc.lineAt(link.from);
			const lineText = view.state.doc.sliceString(line.from, line.to);
			const isUrlOnlyLine = isLineOnlyMdLink(lineText, link.from - line.from, link.to - line.from);

			event.preventDefault();
			view.dom.dispatchEvent(
				new CustomEvent("link-widget-context-menu", {
					bubbles: true,
					detail: {
						url: link.url,
						label: link.label,
						from: link.from,
						to: link.to,
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
			openLinkWidgetUrl(url);
			return true;
		},
	},
});

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
 * `Mod-Shift-v` keymap が native paste を抑止する以上、plain insert する path
 * では native paste と同じ "as-is" 体験を保証する（raw をそのまま挿入）。
 *
 * 分岐:
 * - clipboard が空文字 / null → no-op
 * - clipboard が URL かつコードブロック外 → md リンク化（trimmed URL を [label](<url>) で wrap）
 * - それ以外（非 URL / whitespace-only / コードブロック内 URL）→ raw を lossless 挿入
 */
export function applyClipboardPasteAsMdLink(view: EditorView, raw: string | null): void {
	if (!raw) return; // null / 空文字

	const trimmed = raw.trim();
	const isUrl = trimmed.length > 0 && URL_PASTE_RE.test(trimmed);

	// URL かつコードブロック外 → md リンク化。anyRangeInCodeConstruct は
	// 構文木 walk を含むので URL のときだけ評価する（非 URL paste 時の hot path）
	if (isUrl && !anyRangeInCodeConstruct(view.state)) {
		dispatchUrlInsert(view, trimmed, /* forceConvert */ true);
		return;
	}

	// それ以外 (非 URL / whitespace-only / コードブロック内 URL) → raw を lossless 挿入
	const { state } = view;
	const changes = state.changeByRange((range) => ({
		range: EditorSelection.cursor(range.from + raw.length),
		changes: { from: range.from, to: range.to, insert: raw },
	}));
	view.dispatch({ ...changes, userEvent: "input.paste" });
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
 * 行内に md リンク以外のテキストが無い（前後 trim で空）かを判定する pure 関数。
 * `linkStartInLine` / `linkEndInLine` は行頭からの offset。
 * 右クリック「カードにする」をメニューに出す条件。
 */
export function isLineOnlyMdLink(
	lineText: string,
	linkStartInLine: number,
	linkEndInLine: number,
): boolean {
	// link が行全体を占めるなら slice+trim を回避できる common case
	if (linkStartInLine === 0 && linkEndInLine === lineText.length) return true;
	return (
		lineText.slice(0, linkStartInLine).trim() === "" && lineText.slice(linkEndInLine).trim() === ""
	);
}

/**
 * `pos` を含む Link node を見つけ、その範囲と `[label](url)` の構成要素を
 * 1 回の tree 走査で取り出す。contextmenu handler 用の単一エントリポイント。
 */
function resolveLinkAtPos(
	state: EditorState,
	pos: number,
): { from: number; to: number; url: string; label: string } | null {
	const tree = syntaxTree(state);
	let node = tree.resolveInner(pos, 1);
	while (node && node.name !== "Link") {
		if (!node.parent) return null;
		node = node.parent;
	}
	if (!node) return null;
	const parts = parseLinkNode(state, node);
	if (!parts) return null;
	return { from: node.from, to: node.to, url: parts.url, label: parts.label };
}

/**
 * cmd/ctrl 押下中に editor wrapper (`view.dom`) に `cm-link-mod-down` クラスを
 * 付与し、editor-theme 側の CSS で `.cm-link-widget` の cursor を pointer に
 * 切り替えるための plugin。VS Code 等の cmd+hover 表示と同じ UX。
 *
 * window レベルで listen するのは hover 中 (editor 未 focus) でも反応させる
 * ため。window blur / 別キー押下時の取り残し対策として blur と
 * 全 modifier release 検知も入れる。
 */
const modifierTrackPlugin = ViewPlugin.fromClass(
	class {
		private view: EditorView;
		private onKeyDown: (e: KeyboardEvent) => void;
		private onKeyUp: (e: KeyboardEvent) => void;
		private onBlur: () => void;

		constructor(view: EditorView) {
			this.view = view;
			this.onKeyDown = (e) => {
				if (isOpenLinkModifierKey(e.key)) {
					this.view.dom.classList.add("cm-link-mod-down");
				}
			};
			this.onKeyUp = (e) => {
				// 単独 modifier 解放だけでなく、metaKey/ctrlKey の両方が false に
				// なったら必ず class を外す（OS によっては key === "Meta" でなく
				// "OS" などになる稀ケース対策）
				if (isOpenLinkModifierKey(e.key) || (!e.metaKey && !e.ctrlKey)) {
					this.view.dom.classList.remove("cm-link-mod-down");
				}
			};
			this.onBlur = () => {
				// cmd+Tab でアプリ切替時など keyup が来ないケースで取り残し回避
				this.view.dom.classList.remove("cm-link-mod-down");
			};
			window.addEventListener("keydown", this.onKeyDown);
			window.addEventListener("keyup", this.onKeyUp);
			window.addEventListener("blur", this.onBlur);
		}

		destroy() {
			window.removeEventListener("keydown", this.onKeyDown);
			window.removeEventListener("keyup", this.onKeyUp);
			window.removeEventListener("blur", this.onBlur);
			this.view.dom.classList.remove("cm-link-mod-down");
		}
	},
);

export const linkDecoration: Extension = [linkPlugin, urlPasteHandler, modifierTrackPlugin];
