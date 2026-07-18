import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { cancelOgpFetch, fetchOgp, openExternal } from "../../../lib/commands";
import { LruCache } from "../../../lib/lru-cache";
import { getErrorKind } from "../../../types/errors";
import type { OgpData } from "../../../types/ogp";
import { collectCursorLines, cursorLinesChanged } from "./cursor-utils";
import { isSafeImageUrl, isSafeUrl, URL_PASTE_RE } from "./links";
import { codeRangesField, getCodeRanges, overlapsCodeBlock } from "./math";
import { handleComposingUpdate } from "./plugin-utils";

export function isStandaloneUrlLine(lineText: string): string | null {
	// `URL_PASTE_RE` と同じ shape (`/^https?:\/\/[^\s]+$/i`) — 単一行 URL 検出は
	// paste 判定と同条件なので共有する。
	const trimmed = lineText.trim();
	return URL_PASTE_RE.test(trimmed) ? trimmed : null;
}

/**
 * 行を削除する range を返す。最後の行でなければ末尾の改行も含めて
 * 上下の行が連結するように削除する。最後の行なら直前の改行を含めて
 * 「空行」を残さないようにする。文書が 1 行しかなければその行全体を空にする。
 */
export function getCardDeleteRange(
	doc: {
		length: number;
		lineAt: (pos: number) => { from: number; to: number; number: number };
		lines: number;
	},
	lineFrom: number,
): { from: number; to: number } {
	const line = doc.lineAt(lineFrom);
	if (line.number < doc.lines) {
		// 通常: 行 + 後ろの改行
		return { from: line.from, to: Math.min(doc.length, line.to + 1) };
	}
	if (line.number > 1) {
		// 最終行: 前の改行 + 行
		return { from: Math.max(0, line.from - 1), to: line.to };
	}
	// 1 行しかない: 行内容のみ
	return { from: line.from, to: line.to };
}

type CacheEntry =
	// loading.requestId は開始した plugin instance の発行 ID。cancel 時に
	// 「自分が開始した loading」だけを delete するための owner 識別子。
	| { status: "loading"; cachedAt: number; requestId: string }
	| { status: "loaded"; data: OgpData; cachedAt: number }
	| { status: "error"; errorAt: number };

const MAX_CACHE_SIZE = 500;
const ogpCache = new LruCache<string, CacheEntry>(MAX_CACHE_SIZE);

const ERROR_RETRY_MS = 30_000; // 30秒後にリトライ可能
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間
// 開始者の cancel 後に他 plugin が知らずに loading を待ち続けるのを防ぐ safety net。
// 通常は ABORTED catch → cache.delete → broadcast event で即時復帰するが、何らかの
// 理由で event が届かなかった場合 (broadcast 経路の bug 等) の fallback として 60s 後に
// 別 plugin が re-fetch する。
const LOADING_STALE_MS = 60_000;

// 開始者の plugin instance が完了 (loaded / error) もしくは cancel (ABORTED) で cache
// を更新したことを、生存中の他 plugin に通知する broadcast channel。loading を共有
// している他 view（同じ URL を含む別 EditorView）はこの event でしか自分の view.dispatch
// を発火できないため、cache state を遷移させた直後には必ず broadcast すること。
// CodeMirror の view 間 dispatch は直接的な手段がないため window-level CustomEvent を
// 使う（renderer 内のみ）。
const OGP_CACHE_INVALIDATED_EVENT = "scripta:ogp-cache-invalidated";
interface OgpCacheInvalidatedDetail {
	url: string;
}

function broadcastOgpCacheInvalidated(url: string): void {
	window.dispatchEvent(
		new CustomEvent<OgpCacheInvalidatedDetail>(OGP_CACHE_INVALIDATED_EVENT, {
			detail: { url },
		}),
	);
}

function extractDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

export class LinkCardWidget extends WidgetType {
	url: string;
	ogp: OgpData | null;
	constructor(url: string, ogp: OgpData | null) {
		super();
		this.url = url;
		this.ogp = ogp;
	}

	eq(other: LinkCardWidget): boolean {
		if (this.url !== other.url) return false;
		if (this.ogp === null && other.ogp === null) return true;
		if (this.ogp === null || other.ogp === null) return false;
		return (
			this.ogp.title === other.ogp.title &&
			this.ogp.description === other.ogp.description &&
			this.ogp.image === other.ogp.image &&
			this.ogp.siteName === other.ogp.siteName
		);
	}

	toDOM(): HTMLElement {
		const container = document.createElement("a");
		container.className = "cm-link-card";
		container.dataset.linkCardUrl = this.url;
		container.title = this.url;

		if (isSafeUrl(this.url)) {
			container.href = this.url;
			container.tabIndex = 0;
			const openUrl = () => {
				openExternal(this.url).catch((error) => {
					console.error("Failed to open URL:", this.url, error);
				});
			};
			container.addEventListener("click", (e) => {
				e.preventDefault();
				if (e.button !== 0) return;
				openUrl();
			});
			container.addEventListener("mousedown", (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
			});
			container.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					e.stopPropagation();
					openUrl();
				}
			});
		} else {
			container.tabIndex = -1;
			container.setAttribute("aria-disabled", "true");
		}

		if (!this.ogp) {
			// Loading state
			const loading = document.createElement("div");
			loading.className = "cm-link-card-loading";
			loading.textContent = extractDomain(this.url);
			container.appendChild(loading);
			return container;
		}

		const content = document.createElement("div");
		content.className = "cm-link-card-content";

		const textSection = document.createElement("div");
		textSection.className = "cm-link-card-text";

		if (this.ogp.title) {
			const title = document.createElement("div");
			title.className = "cm-link-card-title";
			title.textContent = this.ogp.title;
			textSection.appendChild(title);
		}

		if (this.ogp.description) {
			const desc = document.createElement("div");
			desc.className = "cm-link-card-description";
			desc.textContent = this.ogp.description;
			textSection.appendChild(desc);
		}

		const domain = document.createElement("div");
		domain.className = "cm-link-card-domain";
		domain.textContent = this.ogp.siteName || extractDomain(this.url);
		textSection.appendChild(domain);

		content.appendChild(textSection);

		let resolvedImageUrl: string | undefined = this.ogp.image ?? undefined;
		if (resolvedImageUrl) {
			try {
				const baseUrl = this.ogp.url || this.url;
				resolvedImageUrl = new URL(resolvedImageUrl, baseUrl).toString();
			} catch {
				resolvedImageUrl = undefined;
			}
		}

		if (resolvedImageUrl && isSafeImageUrl(resolvedImageUrl)) {
			const imgWrapper = document.createElement("div");
			imgWrapper.className = "cm-link-card-thumbnail-wrapper";
			const img = document.createElement("img");
			img.className = "cm-link-card-thumbnail";
			img.src = resolvedImageUrl;
			img.alt = this.ogp.title || "";
			img.loading = "lazy";
			img.addEventListener("error", () => {
				imgWrapper.remove();
			});
			imgWrapper.appendChild(img);
			content.appendChild(imgWrapper);
		}

		container.appendChild(content);
		return container;
	}

	ignoreEvent(event: Event): boolean {
		// 安全なURLのときだけマウスイベントをウィジェット側で処理し、
		// それ以外はエディタにイベントを渡して基本操作を妨げない
		if ((event.type === "mousedown" || event.type === "click") && isSafeUrl(this.url)) {
			return true;
		}
		return false;
	}
}

interface StandaloneUrlInfo {
	line: { from: number; to: number };
	url: string;
}

function forEachStandaloneUrl(view: EditorView, cb: (info: StandaloneUrlInfo) => void): void {
	const { state } = view;
	const cursorLines = collectCursorLines(view);
	const codeRanges = getCodeRanges(state);

	for (const { from, to } of view.visibleRanges) {
		const startLine = state.doc.lineAt(from).number;
		const endLine = state.doc.lineAt(to).number;

		for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
			if (cursorLines.has(lineNum)) continue;

			const line = state.doc.line(lineNum);
			const url = isStandaloneUrlLine(line.text);
			if (!url) continue;

			if (overlapsCodeBlock(line.from, line.to, codeRanges)) continue;

			cb({ line: { from: line.from, to: line.to }, url });
		}
	}
}

function buildDecorations(view: EditorView): DecorationSet {
	const ranges: Range<Decoration>[] = [];

	forEachStandaloneUrl(view, ({ line, url }) => {
		const entry = ogpCache.get(url);
		// Skip if error — show as normal text
		if (entry?.status === "error") return;

		const ogp = entry?.status === "loaded" ? entry.data : null;
		ranges.push(
			Decoration.replace({
				widget: new LinkCardWidget(url, ogp),
			}).range(line.from, line.to),
		);
	});

	return Decoration.set(ranges, true);
}

class LinkCardDecorationPlugin implements PluginValue {
	decorations: DecorationSet;
	prevCursorLines: Set<number>;
	private view: EditorView;
	// URL → 自身が発行した requestId。destroy 時にこの requestId だけを cancel する
	// （他 view の同 URL fetch を巻き込まないため）。
	private fetchingUrls = new Map<string, string>();
	private pendingUpdate = false;
	private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
	private destroyed = false;
	private cacheInvalidatedHandler: (e: Event) => void;

	constructor(view: EditorView) {
		this.view = view;
		this.decorations = buildDecorations(view);
		this.prevCursorLines = collectCursorLines(view);
		// 他 plugin が ABORTED で cache を消したときに自分の view を再評価させるため
		// の listener。view.dispatch で update を発火し、fetchMissingOgp で必要なら
		// 再 fetch する。
		this.cacheInvalidatedHandler = (e: Event) => {
			if (this.destroyed) return;
			const detail = (e as CustomEvent<OgpCacheInvalidatedDetail>).detail;
			if (typeof detail?.url !== "string") return;
			this.pendingUpdate = true;
			this.view.dispatch({});
		};
		window.addEventListener(OGP_CACHE_INVALIDATED_EVENT, this.cacheInvalidatedHandler);
		this.fetchMissingOgp(view);
	}

	private fetchMissingOgp(view: EditorView) {
		forEachStandaloneUrl(view, ({ url }) => {
			if (this.fetchingUrls.has(url)) return;
			const cached = ogpCache.get(url);
			if (cached) {
				if (cached.status === "error") {
					if (Date.now() - cached.errorAt < ERROR_RETRY_MS) return;
				} else if (cached.status === "loading") {
					// 他 plugin が fetch 中なら待つ（その plugin の dispatch で結果が共有
					// される）。ただし開始者が cancel された等で stale な loading は
					// LOADING_STALE_MS 経過後に自分が re-fetch する。
					if (Date.now() - cached.cachedAt < LOADING_STALE_MS) return;
				} else if (Date.now() - cached.cachedAt < CACHE_TTL_MS) {
					return;
				}
			}

			const requestId = crypto.randomUUID();
			ogpCache.set(url, { status: "loading", cachedAt: Date.now(), requestId });
			this.fetchingUrls.set(url, requestId);

			fetchOgp(requestId, url)
				.then((data) => {
					this.fetchingUrls.delete(url);
					// destroyed でも cache の loading→loaded 遷移と broadcast は実行する。
					// 同じ URL を loading で共有している他 view、および将来 mount される view
					// のために結果を残す。`destroyed && skip` 経路だと共有 loading が消えず
					// 待機 view が膠着する（P2）。
					ogpCache.set(url, { status: "loaded", data, cachedAt: Date.now() });
					broadcastOgpCacheInvalidated(url);
				})
				.catch((err: unknown) => {
					this.fetchingUrls.delete(url);
					if (getErrorKind(err) === "ABORTED") {
						// 自分が開始した loading entry だけを削除し、broadcast で他 plugin
						// に即時 re-fetch を促す（他 plugin が loading を共有して待ち続ける
						// 膠着を回避）。loading entry の owner が別の requestId なら触らない
						// — その plugin の責任で更新される。
						const cached = ogpCache.get(url);
						if (cached?.status === "loading" && cached.requestId === requestId) {
							ogpCache.delete(url);
							broadcastOgpCacheInvalidated(url);
						}
						return;
					}
					// error completion も同様に共有 loading を更新 + broadcast。
					ogpCache.set(url, { status: "error", errorAt: Date.now() });
					broadcastOgpCacheInvalidated(url);
				});
		});
	}

	update(update: ViewUpdate) {
		this.view = update.view;

		if (handleComposingUpdate(update, this)) return;

		if (this.pendingUpdate) {
			this.pendingUpdate = false;
			this.cancelRebuild();
			this.decorations = buildDecorations(update.view);
			this.prevCursorLines = collectCursorLines(update.view);
			this.fetchMissingOgp(update.view);
			return;
		}

		if (update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
			this.cancelRebuild();
			this.decorations = buildDecorations(update.view);
			this.prevCursorLines = collectCursorLines(update.view);
			this.fetchMissingOgp(update.view);
		} else if (update.docChanged) {
			this.decorations = this.decorations.map(update.changes);
			this.prevCursorLines = collectCursorLines(update.view);
			// paste で URL を空行に貼ったときは即時 card 表示したいので throttle を skip。
			// 通常の typing は従来通り 150ms 遅延（連続入力中のチャタリング防止）。
			const isPaste = update.transactions.some((tr) => tr.isUserEvent("input.paste"));
			if (isPaste) {
				this.cancelRebuild();
				this.decorations = buildDecorations(update.view);
				this.fetchMissingOgp(update.view);
			} else {
				this.scheduleRebuild();
			}
		} else if (update.selectionSet || update.focusChanged) {
			const next = collectCursorLines(update.view);
			if (cursorLinesChanged(this.prevCursorLines, next)) {
				this.prevCursorLines = next;
				this.decorations = buildDecorations(update.view);
				this.fetchMissingOgp(update.view);
			}
		}
	}

	private scheduleRebuild() {
		if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
		this.rebuildTimer = setTimeout(() => {
			this.rebuildTimer = null;
			if (this.destroyed) return;
			if (this.view.composing) {
				this.scheduleRebuild();
				return;
			}
			this.pendingUpdate = true;
			this.view.dispatch({});
		}, 150);
	}

	private cancelRebuild() {
		if (this.rebuildTimer) {
			clearTimeout(this.rebuildTimer);
			this.rebuildTimer = null;
		}
	}

	destroy() {
		this.destroyed = true;
		this.cancelRebuild();
		window.removeEventListener(OGP_CACHE_INVALIDATED_EVENT, this.cacheInvalidatedHandler);
		// 文書切替 / unmount で自身が発行した requestId だけを cancel する（#101）。
		// URL 単位の cancel だと他 view の後発 request を誤って巻き込むため、requestId
		// ベースで個別停止する。
		for (const requestId of this.fetchingUrls.values()) {
			cancelOgpFetch(requestId).catch((error) => {
				console.error("Failed to cancel OGP fetch:", requestId, error);
			});
		}
		this.fetchingUrls.clear();
	}
}

const linkCardPlugin = ViewPlugin.fromClass(LinkCardDecorationPlugin, {
	decorations: (v) => v.decorations,
});

/**
 * カード表示中の行へのマウスクリックをブロックする。
 * カード内のクリックは ignoreEvent + ウィジェットの mousedown で処理済み。
 * ここではカード外（margin/行間）のクリックでURL行にカーソルが移動するのを防ぐ。
 */
function createLinkCardClickGuard() {
	return EditorView.domEventHandlers({
		mousedown(event: MouseEvent, view: EditorView) {
			// 左クリックのみブロック（右クリック等のコンテキストメニューは通す）
			if (event.button !== 0) return false;

			const target = event.target;
			if (target instanceof Element && target.closest(".cm-link-card")) return false;

			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
			if (pos == null) return false;

			const line = view.state.doc.lineAt(pos);
			const plugin = view.plugin(linkCardPlugin);
			if (!plugin) return false;

			const iter = plugin.decorations.iter();
			while (iter.value) {
				if (iter.from <= line.from && iter.to >= line.to) {
					event.preventDefault();
					return true;
				}
				if (iter.from > line.to) break;
				iter.next();
			}
			return false;
		},
		contextmenu(event: MouseEvent, view: EditorView) {
			const target = event.target;
			if (!(target instanceof Element)) return false;
			const cardEl = target.closest<HTMLElement>(".cm-link-card");
			if (!cardEl) return false;

			// dataset から URL を取得（widget DOM 構築時に設定済み）
			const url = cardEl.dataset.linkCardUrl;
			if (!url) return false;

			// card の DOM 位置から doc position を割り出し、その line range を特定する
			const pos = view.posAtDOM(cardEl);
			const line = view.state.doc.lineAt(pos);

			event.preventDefault();
			view.dom.dispatchEvent(
				new CustomEvent("link-card-context-menu", {
					bubbles: true,
					detail: {
						url,
						lineFrom: line.from,
						lineTo: line.to,
						clientX: event.clientX,
						clientY: event.clientY,
					},
				}),
			);
			return true;
		},
	});
}

export const linkCardDecoration: Extension = [
	codeRangesField,
	linkCardPlugin,
	createLinkCardClickGuard(),
];
