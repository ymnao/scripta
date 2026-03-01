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
import { open } from "@tauri-apps/plugin-shell";
import { fetchOgp } from "../../../lib/commands";
import type { OgpData } from "../../../types/ogp";
import { collectCursorLines } from "./cursor-utils";
import { collectCodeRanges } from "./math";

const STANDALONE_URL_RE = /^https?:\/\/[^\s]+$/;

export function isStandaloneUrlLine(lineText: string): string | null {
	const trimmed = lineText.trim();
	return STANDALONE_URL_RE.test(trimmed) ? trimmed : null;
}

type CacheEntry = { status: "loading" } | { status: "loaded"; data: OgpData } | { status: "error" };

const ogpCache = new Map<string, CacheEntry>();

function extractDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

export class LinkCardWidget extends WidgetType {
	constructor(
		readonly url: string,
		readonly ogp: OgpData | null,
	) {
		super();
	}

	eq(other: LinkCardWidget): boolean {
		if (this.url !== other.url) return false;
		if (this.ogp === null && other.ogp === null) return true;
		if (this.ogp === null || other.ogp === null) return false;
		return (
			this.ogp.title === other.ogp.title &&
			this.ogp.description === other.ogp.description &&
			this.ogp.image === other.ogp.image
		);
	}

	toDOM(): HTMLElement {
		const container = document.createElement("a");
		container.className = "cm-link-card";
		container.dataset.linkCardUrl = this.url;
		container.title = this.url;

		container.addEventListener("mousedown", (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			open(this.url).catch((error) => {
				console.error("Failed to open URL:", this.url, error);
			});
		});

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

		if (this.ogp.image) {
			const imgWrapper = document.createElement("div");
			imgWrapper.className = "cm-link-card-thumbnail-wrapper";
			const img = document.createElement("img");
			img.className = "cm-link-card-thumbnail";
			img.src = this.ogp.image;
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
		// false = ウィジェットが処理（エディタはカーソル移動しない）
		if (event.type === "mousedown" || event.type === "click") return false;
		return true;
	}
}

function isInsideCodeBlock(
	lineFrom: number,
	lineTo: number,
	codeRanges: { from: number; to: number }[],
): boolean {
	for (const range of codeRanges) {
		if (lineFrom < range.to && lineTo > range.from) return true;
	}
	return false;
}

function buildDecorations(view: EditorView): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);

	const cursorLines = collectCursorLines(view);

	const ranges: Range<Decoration>[] = [];

	for (const { from, to } of view.visibleRanges) {
		const codeRanges = collectCodeRanges(tree, from, to);

		const startLine = state.doc.lineAt(from).number;
		const endLine = state.doc.lineAt(to).number;

		for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
			if (cursorLines.has(lineNum)) continue;

			const line = state.doc.line(lineNum);
			const url = isStandaloneUrlLine(line.text);
			if (!url) continue;

			if (isInsideCodeBlock(line.from, line.to, codeRanges)) continue;

			const entry = ogpCache.get(url);
			// Skip if error — show as normal text
			if (entry?.status === "error") continue;

			const ogp = entry?.status === "loaded" ? entry.data : null;
			ranges.push(
				Decoration.replace({
					widget: new LinkCardWidget(url, ogp),
				}).range(line.from, line.to),
			);
		}
	}

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
		const { state } = view;

		for (const { from, to } of view.visibleRanges) {
			const startLine = state.doc.lineAt(from).number;
			const endLine = state.doc.lineAt(to).number;

			for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
				const line = state.doc.line(lineNum);
				const url = isStandaloneUrlLine(line.text);
				if (!url) continue;
				if (ogpCache.has(url)) continue;
				if (this.fetchingUrls.has(url)) continue;

				ogpCache.set(url, { status: "loading" });
				this.fetchingUrls.add(url);

				fetchOgp(url)
					.then((data) => {
						this.fetchingUrls.delete(url);
						if (this.destroyed) return;
						ogpCache.set(url, { status: "loaded", data });
						this.pendingUpdate = true;
						this.view.dispatch({});
					})
					.catch(() => {
						this.fetchingUrls.delete(url);
						if (this.destroyed) return;
						ogpCache.set(url, { status: "error" });
						this.pendingUpdate = true;
						this.view.dispatch({});
					});
			}
		}
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
