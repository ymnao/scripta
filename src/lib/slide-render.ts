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

export interface RenderSlideHtmlOptions {
	mermaidOptions?: MermaidRenderOptions;
	embedOptions?: { rasterize?: boolean };
	/**
	 * `preprocessMermaidBlocks` → `renderMermaid` へ協調的キャンセルを伝搬する。
	 * theme / activeTabPath 連打時の CPU waste 軽減 (useAsyncDerived の cleanup
	 * が abort → 次ブロックの mermaid render に入る前に AbortError で早期終了)。
	 */
	signal?: AbortSignal;
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
 * mermaid fence を含まない markdown は `preprocessMermaidBlocks` が no-op で返す
 * (line-scan 1 回のみ) ので、fast path を追加せず単一経路で扱う (fence 判定ロジックを
 * 二重化しない = case sensitivity 等の divergence 源を潰す)。
 */
export async function renderSlideHtmlWithMermaid(
	markdown: string,
	activeTabPath: string | null,
	theme: "light" | "dark",
	options?: RenderSlideHtmlOptions,
): Promise<string> {
	const cleaned = markdown.replace(/\n---\s*$/, "").trim();
	if (!cleaned) return "";
	const withMermaid = await preprocessMermaidBlocks(
		cleaned,
		theme,
		options?.mermaidOptions,
		options?.embedOptions,
		options?.signal,
	);
	return resolveHtmlImageSrcs(markdownToHtml(withMermaid), activeTabPath);
}
