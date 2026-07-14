import { markdownToHtml } from "./markdown-to-html";
import type { MermaidRenderOptions } from "./mermaid";
import { preprocessMermaidBlocks } from "./mermaid-preprocess";
import { resolveHtmlImageSrcs } from "./resolve-html-images";

/**
 * スライド本文の Markdown を DOMPurify 済み HTML に変換する純粋関数（sync 版）。
 * 末尾の区切り行 `---` は除去する。mermaid ブロックは fenced code のまま残るため、
 * mermaid をレンダリングしたい場合は `renderSlideHtmlWithMermaid` を使う。
 */
export function renderSlideHtml(markdown: string, activeTabPath: string | null): string {
	const cleaned = markdown.replace(/\n---\s*$/, "").trim();
	if (!cleaned) return "";
	return resolveHtmlImageSrcs(markdownToHtml(cleaned), activeTabPath);
}

/**
 * mermaid ブロックが少なくとも 1 つ含まれる可能性がある場合のみ true を返す軽量判定。
 * fenced code の開始行 (``` 3 個以上 + `mermaid`) を line-based で検出する。false ならば
 * `preprocessMermaidBlocks` の async 経路をスキップして sync 版と同一の結果になる。
 */
export function containsMermaidFence(markdown: string): boolean {
	return /(^|\n)\s*`{3,}\s*mermaid\s*(\n|$)/i.test(markdown);
}

export interface RenderSlideHtmlOptions {
	mermaidOptions?: MermaidRenderOptions;
	embedOptions?: { rasterize?: boolean };
}

/**
 * mermaid ブロックを SVG (または PNG) に変換した上で HTML を生成する async 版。
 * SlidePreview / 発表モードで mermaid を反映するために使う (Fable #8)。
 * mermaid 側キャッシュにより、同一 (source, theme, font) の 2 回目以降は即時。
 *
 * `options` を渡すと `exportSlidesAsPdf` 経路と共有できる (PDF は
 * `{ mermaidOptions: { htmlLabels: false, useMaxWidth: false }, embedOptions: { rasterize: true } }`)。
 * こうして「スライド 1 枚 → HTML」の contract (末尾 `---` 除去 / 空文字 convention /
 * mermaid → markdown → image resolve の順序) を preview / 発表 / PDF export で一致させる。
 *
 * mermaid fence を含まない markdown は sync 版と同じ結果になるため、preprocess を
 * スキップして 1 回だけの `markdownToHtml` に短縮する (typing 中の hot path 最適化)。
 */
export async function renderSlideHtmlWithMermaid(
	markdown: string,
	activeTabPath: string | null,
	theme: "light" | "dark",
	options?: RenderSlideHtmlOptions,
): Promise<string> {
	const cleaned = markdown.replace(/\n---\s*$/, "").trim();
	if (!cleaned) return "";
	if (!containsMermaidFence(cleaned)) {
		return resolveHtmlImageSrcs(markdownToHtml(cleaned), activeTabPath);
	}
	const withMermaid = await preprocessMermaidBlocks(
		cleaned,
		theme,
		options?.mermaidOptions,
		options?.embedOptions,
	);
	return resolveHtmlImageSrcs(markdownToHtml(withMermaid), activeTabPath);
}
