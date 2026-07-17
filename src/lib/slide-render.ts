import { abortError } from "./abort";
import { markdownToHtml } from "./markdown-to-html";
import type { MermaidRenderOptions } from "./mermaid";
import { preprocessMermaidBlocks } from "./mermaid-preprocess";
import { resolveHtmlImageSrcs } from "./resolve-html-images";

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
	const cleaned = markdown.replace(/\n---\s*$/, "").trim();
	if (!cleaned) return "";
	const key = `${activeTabPath ?? ""}\0${cleaned}`;
	const hit = syncCache.get(key);
	if (hit !== undefined) {
		// LRU: 直近アクセスを末尾へ
		syncCache.delete(key);
		syncCache.set(key, hit);
		return hit;
	}
	const html = resolveHtmlImageSrcs(markdownToHtml(cleaned), activeTabPath);
	syncCache.set(key, html);
	while (syncCache.size > MAX_CACHE_SIZE) {
		const oldest = syncCache.keys().next().value;
		if (oldest === undefined) break;
		syncCache.delete(oldest);
	}
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
const syncCache = new Map<string, string>();
const asyncCache = new Map<string, AsyncCacheEntry>();

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
	return resolveHtmlImageSrcs(markdownToHtml(withMermaid), activeTabPath);
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
 *   throw して cache エントリを作らない (新規 render を起動しない)。
 * - **eviction 時のみ entry の controller を abort**: LRU cap 超過 (128) で古い entry を
 *   evict する際に entry の controller を abort → downstream の preprocess loop-head /
 *   mermaid pre-check で残作業を skip (協調的キャンセル)。
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
	const cleaned = markdown.replace(/\n---\s*$/, "").trim();
	if (!cleaned) return Promise.resolve("");
	const callerSignal = options?.signal;
	if (shouldBypassCache(options)) {
		return renderSlideHtmlDirect(cleaned, activeTabPath, theme, options, callerSignal);
	}
	const key = `${theme}\0${activeTabPath ?? ""}\0${cleaned}`;
	const hit = asyncCache.get(key);
	if (hit) {
		// cache-hit は caller の signal 状態に関わらず shared promise を返す
		// (session 90 の「1 caller の意思で shared cache を reject させない」原則)。
		asyncCache.delete(key);
		asyncCache.set(key, hit);
		return hit.promise;
	}
	// cache-miss + pre-abort されている場合のみ「新規 render を起動しない」意味で reject する
	// (cache に entry を作らない = 他 caller が cache 経由で拾わない)。
	if (callerSignal?.aborted) return Promise.reject(abortError());
	const controller = new AbortController();
	const promise = renderSlideHtmlDirect(cleaned, activeTabPath, theme, options, controller.signal);
	// 失敗した Promise を cache に固定させない (次 render で retry させる)。
	promise.catch(() => {
		if (asyncCache.get(key)?.promise === promise) asyncCache.delete(key);
	});
	asyncCache.set(key, { promise, controller });
	while (asyncCache.size > MAX_CACHE_SIZE) {
		const [oldestKey, oldestEntry] = asyncCache.entries().next().value ?? [];
		if (oldestKey === undefined) break;
		asyncCache.delete(oldestKey);
		oldestEntry?.controller.abort();
	}
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
