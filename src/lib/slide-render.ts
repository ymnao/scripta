import { abortError } from "./abort";
import { finalizeHtml } from "./finalize-html";
import { LruCache } from "./lru-cache";
import { markdownToHtmlRaw } from "./markdown-to-html";
import type { MermaidRenderOptions } from "./mermaid";
import { preprocessMermaidBlocks } from "./mermaid-preprocess";
import { resolveHtmlImageSrcs } from "./resolve-html-images";

/**
 * 末尾の区切り行 `---` を除去して trim する。`renderSlideHtml` / `renderSlideHtmlWithMermaid`
 * の両方で同じ regex を書くと preview / 発表 / PDF export で契約が drift するリスクが
 * あるため 1 箇所に集約する (JSDoc 記述と対応)。
 */
function cleanSlideMarkdown(markdown: string): string {
	return markdown.replace(/\n---\s*$/, "").trim();
}

/**
 * スライド本文の Markdown を DOMPurify 済み HTML に変換する純粋関数（sync 版）。
 * 末尾の区切り行 `---` は除去する。mermaid ブロックは fenced code のまま残るため、
 * mermaid をレンダリングしたい場合は `renderSlideHtmlWithMermaid` を使う。
 *
 * 結果は module-level LRU キャッシュ (theme に依らず (activeTabPath, cleaned) キー) に
 * 保持され、`useSlideHtml` / `useSlideHtmls` の初期同期段階の N-1 枚分の
 * markdownToHtml + DOMPurify + regex 呼び出しを skip する (session 87 の per-slide
 * cache が hook-instance-local だったのを module scope に集約、複数 hook instance で
 * 共有できる)。
 */
export function renderSlideHtml(markdown: string, activeTabPath: string | null): string {
	const cleaned = cleanSlideMarkdown(markdown);
	if (!cleaned) return "";
	const key = `${activeTabPath ?? ""}\0${cleaned}`;
	const hit = syncCache.get(key);
	if (hit !== undefined) return hit;
	const html = finalizeHtml(resolveHtmlImageSrcs(markdownToHtmlRaw(cleaned), activeTabPath), {
		allowAssetProtocol: true,
	});
	syncCache.set(key, html);
	return html;
}

export interface RenderSlideHtmlOptions {
	mermaidOptions?: MermaidRenderOptions;
	embedOptions?: { rasterize?: boolean };
	/**
	 * `preprocessMermaidBlocks` → `renderMermaid` へ協調的キャンセルを伝搬する。
	 * theme / activeTabPath 連打時の CPU waste 軽減 (useAsyncDerived の cleanup
	 * が abort → 次ブロックの mermaid render に入る前に AbortError で早期終了)。
	 *
	 * cache-hit 経路では caller の signal は共有 promise の状態変化に使わない
	 * (session 90 の「1 caller の意思で shared cache を reject させない」原則)。
	 * pre-abort されている場合のみ「新規 render を起動しない」pre-check に使う。
	 */
	signal?: AbortSignal;
}

interface AsyncCacheEntry {
	promise: Promise<string>;
	controller: AbortController;
}

const MAX_CACHE_SIZE = 128;
const syncCache = new LruCache<string, string>(MAX_CACHE_SIZE);
const asyncCache = new LruCache<string, AsyncCacheEntry>(MAX_CACHE_SIZE);

/**
 * カスタム mermaid / embed オプションが指定された場合は module cache を bypass する
 * (PDF export 経路の `rasterize: true` / `htmlLabels: false` 等は出力 HTML が異なるため
 * preview cache と混在させると SVG → PNG の相互汚染になる)。
 */
function shouldBypassCache(options?: RenderSlideHtmlOptions): boolean {
	return !!(options?.mermaidOptions || options?.embedOptions);
}

async function renderSlideHtmlDirect(
	cleaned: string,
	activeTabPath: string | null,
	theme: "light" | "dark",
	options: RenderSlideHtmlOptions | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const withMermaid = await preprocessMermaidBlocks(
		cleaned,
		theme,
		options?.mermaidOptions,
		options?.embedOptions,
		signal,
	);
	return finalizeHtml(resolveHtmlImageSrcs(markdownToHtmlRaw(withMermaid), activeTabPath), {
		allowAssetProtocol: true,
	});
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
 *
 * ## Module-level async cache
 *
 * (theme, activeTabPath, cleaned markdown) キーで in-flight promise / 完了 promise を
 * 共有 (session 87 の hook-instance-local per-slide cache を集約、cross-hook / cross-mount
 * 再利用可能に)。以下の設計原則を守る (session 90 の cross-instance poisoning 対策継続):
 *
 * - **1 caller の signal では共有 promise の状態を変えない**: cache-hit 時は caller の
 *   signal を無視して shared promise を返す (caller 側の useAsyncDerived が cancelled
 *   flag で await 継続を捨てる)。
 * - **cache-miss 時のみ pre-abort check**: caller signal が既に aborted なら AbortError で
 *   reject して cache エントリを作らない (新規 render を起動しない)。
 * - **LRU eviction は entry を delete するだけで controller を abort しない**: `useSlideHtmls`
 *   の `Promise.all(slides.map(...))` は 1 batch 中に N 個の cache-miss を同期的に登録するため、
 *   N > MAX_CACHE_SIZE の deck では 129 個目の set が 1 個目の in-flight entry を evict する。
 *   evict 時に abort すると同 batch 中の兄弟 promise が AbortError で reject → Promise.all
 *   全体 reject → useAsyncDerived が silent 化 (isAbortError) → deck が凍結、というシナリオが
 *   起きる (session 91 で /code-review 3 angle が同時 surface)。orphan render は完了まで走らせて
 *   結果を捨てる (bounded CPU waste) — abort による cross-instance poisoning より安全。
 * - **`clearSlideRenderCache` のみ entry を abort**: テスト isolation 用の全消し経路では
 *   in-flight を abort する (テスト間で lingering CPU work を残さない)。
 * - **カスタム options 経路は cache bypass**: `mermaidOptions` / `embedOptions` 指定
 *   (PDF export 等) は module cache を通さず直接 render (出力 HTML が異なるため相互汚染
 *   を避ける)。
 *
 * ⚠️ この関数は意図的に非 async にしている: cache-hit 時に entry の promise identity を
 * そのまま呼び出し側に返すため。async 関数は return された promise も新しい promise で
 * ラップするので `===` が成り立たず、複数 caller の in-flight dedup が観測できなくなる。
 */
export function renderSlideHtmlWithMermaid(
	markdown: string,
	activeTabPath: string | null,
	theme: "light" | "dark",
	options?: RenderSlideHtmlOptions,
): Promise<string> {
	const cleaned = cleanSlideMarkdown(markdown);
	if (!cleaned) return Promise.resolve("");
	const callerSignal = options?.signal;
	if (shouldBypassCache(options)) {
		return renderSlideHtmlDirect(cleaned, activeTabPath, theme, options, callerSignal);
	}
	const key = `${theme}\0${activeTabPath ?? ""}\0${cleaned}`;
	const hit = asyncCache.get(key);
	// cache-hit は caller の signal 状態に関わらず shared promise を返す
	// (session 90 の「1 caller の意思で shared cache を reject させない」原則)。
	if (hit !== undefined) return hit.promise;
	// cache-miss + pre-abort されている場合のみ「新規 render を起動しない」意味で reject する
	// (cache に entry を作らない = 他 caller が cache 経由で拾わない)。
	if (callerSignal?.aborted) return Promise.reject(abortError());
	const controller = new AbortController();
	const promise = renderSlideHtmlDirect(cleaned, activeTabPath, theme, options, controller.signal);
	// 失敗した Promise を cache に固定させない (次 render で retry させる)。peek で
	// LRU 順序を変えずに identity 照合してから delete する。
	promise.catch(() => {
		if (asyncCache.peek(key)?.promise === promise) asyncCache.delete(key);
	});
	// LruCache.set 側で eviction を実施する。eviction では abort しない (self-poisoning
	// 対策、上記 JSDoc 参照)。orphan render は完了まで走らせて結果は捨てる。in-flight を
	// 止められるのは clearSlideRenderCache のみ。
	asyncCache.set(key, { promise, controller });
	return promise;
}

/**
 * テスト間で cache を分離するためのフック。sync + async 両方を対象とし、
 * async の in-flight entry は controller.abort() でキャンセルする
 * (mermaid.ts の `clearMermaidCache` と同ポリシー)。
 */
export function clearSlideRenderCache(): void {
	syncCache.clear();
	for (const entry of asyncCache.values()) entry.controller.abort();
	asyncCache.clear();
}
