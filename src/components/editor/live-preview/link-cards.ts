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
import { fetchOgp, openExternal } from "../../../lib/commands";
import type { OgpData } from "../../../types/ogp";
import { collectCursorLines } from "./cursor-utils";
import { isSafeImageUrl, isSafeUrl } from "./links";
import { collectCodeRanges, overlapsCodeBlock } from "./math";

const STANDALONE_URL_RE = /^https?:\/\/[^\s]+$/i;

export function isStandaloneUrlLine(lineText: string): string | null {
	const trimmed = lineText.trim();
	return STANDALONE_URL_RE.test(trimmed) ? trimmed : null;
}

type CacheEntry =
	| { status: "loading"; cachedAt: number }
	| { status: "loaded"; data: OgpData; cachedAt: number }
	| { status: "error"; errorAt: number };

const ogpCache = new Map<string, CacheEntry>();

const ERROR_RETRY_MS = 30_000; // 30秒後にリトライ可能
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24時間
const MAX_CACHE_ENTRIES = 500;

function evictStaleCache() {
	const now = Date.now();
	for (const [key, entry] of ogpCache) {
		const age = entry.status === "error" ? now - entry.errorAt : now - entry.cachedAt;
		if (age > CACHE_TTL_MS) {
			ogpCache.delete(key);
		}
	}
	if (ogpCache.size > MAX_CACHE_ENTRIES) {
		const entries = [...ogpCache.entries()].sort((a, b) => {
			const timeA = a[1].status === "error" ? a[1].errorAt : a[1].cachedAt;
			const timeB = b[1].status === "error" ? b[1].errorAt : b[1].cachedAt;
			return timeA - timeB;
		});
		const excess = ogpCache.size - MAX_CACHE_ENTRIES;
		for (let i = 0; i < excess; i++) {
			ogpCache.delete(entries[i][0]);
		}
	}
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
	const tree = syntaxTree(state);
	const cursorLines = collectCursorLines(view);

	for (const { from, to } of view.visibleRanges) {
		const codeRanges = collectCodeRanges(tree, from, to);
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
	private view: EditorView;
	private fetchingUrls = new Set<string>();
	private pendingUpdate = false;
	private destroyed = false;

	constructor(view: EditorView) {
		this.view = view;
		this.decorations = buildDecorations(view);
		this.fetchMissingOgp(view);
	}

	private fetchMissingOgp(view: EditorView) {
		let evicted = false;
		forEachStandaloneUrl(view, ({ url }) => {
			if (this.fetchingUrls.has(url)) return;
			const cached = ogpCache.get(url);
			if (cached) {
				if (cached.status === "error") {
					if (Date.now() - cached.errorAt < ERROR_RETRY_MS) return;
				} else if (Date.now() - cached.cachedAt < CACHE_TTL_MS) {
					return;
				}
			}

			if (!evicted) {
				evictStaleCache();
				evicted = true;
			}
			ogpCache.set(url, { status: "loading", cachedAt: Date.now() });
			this.fetchingUrls.add(url);

			fetchOgp(url)
				.then((data) => {
					this.fetchingUrls.delete(url);
					ogpCache.set(url, { status: "loaded", data, cachedAt: Date.now() });
					if (this.destroyed) return;
					this.pendingUpdate = true;
					this.view.dispatch({});
				})
				.catch(() => {
					this.fetchingUrls.delete(url);
					ogpCache.set(url, { status: "error", errorAt: Date.now() });
					if (this.destroyed) return;
					this.pendingUpdate = true;
					this.view.dispatch({});
				});
		});
	}

	update(update: ViewUpdate) {
		this.view = update.view;

		if (this.pendingUpdate) {
			this.pendingUpdate = false;
			this.decorations = buildDecorations(update.view);
			this.fetchMissingOgp(update.view);
			return;
		}

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
			this.fetchMissingOgp(update.view);
		}
	}

	destroy() {
		this.destroyed = true;
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
	});
}

export const linkCardDecoration: Extension = [linkCardPlugin, createLinkCardClickGuard()];
