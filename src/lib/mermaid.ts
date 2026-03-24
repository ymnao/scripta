import DOMPurify from "dompurify";

type CacheEntry =
	| { status: "rendering"; promise: Promise<string> }
	| { status: "rendered"; svg: string }
	| { status: "error"; message: string };

const MAX_CACHE_SIZE = 128;
const cache = new Map<string, CacheEntry>();
/** clearMermaidCache 呼び出しごとにインクリメントし、古い世代のレンダリング結果を無視する */
let cacheGeneration = 0;

let mermaidModule: typeof import("mermaid") | null = null;
let initPromise: Promise<void> | null = null;
let idCounter = 0;
/** initialize+render をアトミックに直列化するキュー */
let renderQueue: Promise<void> = Promise.resolve();

function getMermaidTheme(theme: "light" | "dark"): "dark" | "default" {
	return theme === "dark" ? "dark" : "default";
}

// SVG テキストに薄い縁取りを付けて、明るい rect 背景上でも暗い背景上でも読めるようにする
const THEME_CSS = `
text.messageText, text.noteText, text.labelText, text.loopText {
  paint-order: stroke fill;
  stroke-width: 2px;
  stroke-linejoin: round;
}
`;

function getThemeCss(theme: "light" | "dark"): string {
	// ライト: 白い縁取り（暗い文字を際立たせる）
	// ダーク: 暗い縁取り（明るい文字を明るい rect 上でも読めるようにする）
	const strokeColor = theme === "dark" ? "#1a1a2e" : "#ffffff";
	return `${THEME_CSS} text.messageText, text.noteText, text.labelText, text.loopText { stroke: ${strokeColor}; }`;
}

/**
 * Mermaid SVG をサニタイズする。
 * DOMPurify は SVG 内の <foreignObject> の HTML コンテンツを削除してしまうため、
 * SVG 部分と foreignObject 内の HTML を分離してそれぞれサニタイズし、再結合する。
 */
export function sanitizeMermaidSvg(rawSvg: string): string {
	const parser = new DOMParser();
	const serializer = new XMLSerializer();
	const originalDoc = parser.parseFromString(rawSvg, "image/svg+xml");

	// パースエラーの場合は文字列ベースでサニタイズして返す
	if (originalDoc.querySelector("parsererror")) {
		return DOMPurify.sanitize(rawSvg, {
			USE_PROFILES: { svg: true, svgFilters: true },
			ADD_TAGS: ["foreignObject"],
		});
	}

	const originalFOs = originalDoc.querySelectorAll("foreignObject");

	// foreignObject が無い場合は単純にサニタイズ結果を返す
	if (originalFOs.length === 0) {
		return DOMPurify.sanitize(rawSvg, {
			USE_PROFILES: { svg: true, svgFilters: true },
			ADD_TAGS: ["foreignObject"],
		});
	}

	// 各 foreignObject に一意な data 属性を付与し、安定した対応付けを行う
	const originalFoMap = new Map<string, Element>();
	originalFOs.forEach((fo, index) => {
		const id = `fo-${index}`;
		fo.setAttribute("data-fo-id", id);
		originalFoMap.set(id, fo);
	});

	// data-fo-id を埋め込んだ SVG を XMLSerializer で文字列化し DOMPurify でサニタイズ
	const svgWithIds = serializer.serializeToString(originalDoc.documentElement);
	const sanitized = DOMPurify.sanitize(svgWithIds, {
		USE_PROFILES: { svg: true, svgFilters: true },
		ADD_TAGS: ["foreignObject"],
		ADD_ATTR: ["data-fo-id"],
	});

	// サニタイズ済み SVG を再パースし、foreignObject 内の HTML を個別にサニタイズして再注入
	const sanitizedDoc = parser.parseFromString(sanitized, "image/svg+xml");
	const sanitizedFOs = sanitizedDoc.querySelectorAll("foreignObject");

	for (const fo of sanitizedFOs) {
		const id = fo.getAttribute("data-fo-id");
		if (!id) continue;
		const originalFO = originalFoMap.get(id);
		if (!originalFO) continue;
		const foContent = DOMPurify.sanitize(originalFO.innerHTML, {
			USE_PROFILES: { html: true },
			FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input"],
			FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
		});
		fo.innerHTML = foContent;
		fo.removeAttribute("data-fo-id");
	}

	return serializer.serializeToString(sanitizedDoc.documentElement);
}

function buildConfig(theme: "light" | "dark") {
	return {
		startOnLoad: false,
		securityLevel: "strict" as const,
		theme: getMermaidTheme(theme),
		themeCSS: getThemeCss(theme),
		fontSize: 14,
		flowchart: {
			nodeSpacing: 40,
			rankSpacing: 40,
			padding: 12,
			diagramPadding: 8,
		},
		sequence: {
			diagramMarginX: 25,
			diagramMarginY: 5,
			actorMargin: 30,
			boxMargin: 6,
			boxTextMargin: 4,
			messageMargin: 28,
		},
	};
}

async function ensureInitialized(theme: "light" | "dark"): Promise<void> {
	if (!mermaidModule) {
		if (!initPromise) {
			initPromise = import("mermaid").then((m) => {
				mermaidModule = m;
			});
		}
		await initPromise;
	}
	if (mermaidModule) {
		mermaidModule.default.initialize(buildConfig(theme));
	}
}

function cacheKey(source: string, theme: "light" | "dark"): string {
	return `${theme}:${source}`;
}

/** キャッシュが上限を超えた場合、古いエントリを削除する。
 *  まず完了済みエントリを優先的に削除し、それでも不足する場合は rendering 中も含めて削除する。 */
function evictIfNeeded(): void {
	if (cache.size < MAX_CACHE_SIZE) return;
	// Map は insert 順を保持するので、先頭の完了済みエントリから削除する
	for (const [key, entry] of cache) {
		if (entry.status !== "rendering") {
			cache.delete(key);
			if (cache.size < MAX_CACHE_SIZE) return;
		}
	}
	// 完了済みだけでは足りない場合、rendering 中も含めて削除する
	for (const [key] of cache) {
		cache.delete(key);
		if (cache.size < MAX_CACHE_SIZE) break;
	}
}

/**
 * Mermaid ソースコードを SVG 文字列にレンダリングする。
 * 動的 import でバンドルサイズを軽減し、結果をキャッシュする。
 * 同一 (source, theme) の重複呼び出しは Promise を共有し、
 * initialize+render は排他キューで直列化してテーマ競合を防ぐ。
 */
export async function renderMermaid(source: string, theme: "light" | "dark"): Promise<string> {
	const key = cacheKey(source, theme);
	const cached = cache.get(key);
	if (cached?.status === "rendered") return cached.svg;
	if (cached?.status === "error") throw new Error(cached.message);
	if (cached?.status === "rendering") return cached.promise;

	const gen = cacheGeneration;
	const promise = new Promise<string>((resolve, reject) => {
		renderQueue = renderQueue.then(async () => {
			// キャッシュがクリアされていたら結果を書き戻さない
			if (gen !== cacheGeneration) {
				reject(new Error("Cache generation mismatch"));
				return;
			}
			// キュー待ち中に別の呼び出しで完了済みになっている可能性
			const entry = cache.get(key);
			if (entry?.status === "rendered") {
				resolve(entry.svg);
				return;
			}
			if (entry?.status === "error") {
				reject(new Error(entry.message));
				return;
			}
			try {
				await ensureInitialized(theme);
				const id = `mermaid-${idCounter++}`;
				const result = await mermaidModule?.default.render(id, source);
				const rawSvg = result?.svg ?? "";
				const svg = sanitizeMermaidSvg(rawSvg);
				// レンダリング中にキャッシュがクリア/エビクトされていたら書き戻さない
				if (gen !== cacheGeneration || !cache.has(key)) {
					resolve(svg);
					return;
				}
				cache.set(key, { status: "rendered", svg });
				resolve(svg);
			} catch (e) {
				if (gen === cacheGeneration && cache.has(key)) {
					const message = e instanceof Error ? e.message : String(e);
					cache.set(key, { status: "error", message });
				}
				reject(e);
			}
		});
	});

	evictIfNeeded();
	cache.set(key, { status: "rendering", promise });
	return promise;
}

/**
 * キャッシュからエントリを取得する。
 */
export function getCacheEntry(source: string, theme: "light" | "dark"): CacheEntry | undefined {
	return cache.get(cacheKey(source, theme));
}

/**
 * テーマ変更時にキャッシュをクリアする。
 */
export function clearMermaidCache(): void {
	cacheGeneration++;
	cache.clear();
}

// ── SVG スタイルのインライン化 ────────

/**
 * Mermaid SVG 内の `<style>` ルールを各要素のインラインスタイルに展開する。
 * WKWebView が `tauri://` プロトコル下で SVG 内の `<style>` タグを
 * 正しく処理しないため、スタイルシート処理を完全にバイパスする。
 * :hover 等の擬似クラスはインライン化できないため `<style>` は残す。
 */
export function promoteMermaidStyles(svgEl: Element): void {
	const styleEl = svgEl.querySelector("style");
	if (!styleEl?.textContent) return;

	try {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(styleEl.textContent);

		for (const rule of sheet.cssRules) {
			if (!(rule instanceof CSSStyleRule)) continue;

			let targets: Element[];
			try {
				targets = [...svgEl.querySelectorAll(rule.selectorText)];
				// SVG ルート自身もセレクタに一致するか確認
				if (svgEl.matches(rule.selectorText)) targets.push(svgEl);
			} catch {
				continue; // 擬似クラス等の複雑なセレクタはスキップ
			}

			for (const el of targets) {
				const elStyle = (el as HTMLElement | SVGElement).style;
				for (let i = 0; i < rule.style.length; i++) {
					const prop = rule.style[i];
					// 既存のインラインスタイルは上書きしない
					if (elStyle.getPropertyValue(prop)) continue;
					elStyle.setProperty(
						prop,
						rule.style.getPropertyValue(prop),
						rule.style.getPropertyPriority(prop),
					);
				}
			}
		}
	} catch {
		// replaceSync に失敗した場合は元の <style> がそのまま機能する
	}
}
