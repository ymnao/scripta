import DOMPurify from "dompurify";
import { FONT_FAMILY_MAP } from "../components/editor/editor-theme";
import { useSettingsStore } from "../stores/settings";

type CacheEntry =
	| { status: "rendering"; promise: Promise<string> }
	| { status: "rendered"; svg: string }
	| { status: "error"; message: string };

const MAX_CACHE_SIZE = 128;
const cache = new Map<string, CacheEntry>();
/** clearMermaidCache 呼び出しごとにインクリメントし、古い世代のレンダリング結果を無視する */
let cacheGeneration = 0;

/** WKWebView tauri:// プロトコル下で動作しているか */
export const isTauriProtocol =
	typeof window !== "undefined" && window.location?.protocol === "tauri:";

let mermaidModule: typeof import("mermaid") | null = null;
let initPromise: Promise<void> | null = null;
let idCounter = 0;
/** initialize+render をアトミックに直列化するキュー */
let renderQueue: Promise<void> = Promise.resolve();

/**
 * mermaid.render() 中に d3.style('text-anchor', value) で設定される値を
 * プレゼンテーション属性にミラーする。
 *
 * WKWebView tauri:// は CSS の text-anchor をレンダリングに反映しないが、
 * プレゼンテーション属性（レンダリング中の setAttribute）は有効。
 * d3.style() はインラインスタイルを設定するが、WKWebView はこれも無視する。
 * そこで style.setProperty をインターセプトし、text-anchor が設定された時点で
 * 同じ値をプレゼンテーション属性にもミラーする。
 *
 * これにより各テキスト要素が Mermaid の意図通りの text-anchor 値を属性として持つ:
 * - flowchart ノード: "middle" → 中央揃え
 * - ER/class メンバー: "start" → 左揃え
 * - 全テキストに "middle" を強制する前の方式の問題（Type B テキストの左はみ出し）を解消。
 */
function patchTextAnchor(): () => void {
	const origCreateElementNS = document.createElementNS.bind(document);
	document.createElementNS = ((namespaceURI: string, qualifiedName: string) => {
		const el = origCreateElementNS(namespaceURI, qualifiedName);
		if (namespaceURI === "http://www.w3.org/2000/svg" && qualifiedName === "text") {
			const svgEl = el as SVGTextElement;
			const origSetProp = svgEl.style.setProperty.bind(svgEl.style);
			svgEl.style.setProperty = (prop: string, value: string | null, priority?: string) => {
				if (prop === "text-anchor" && value) {
					svgEl.setAttribute("text-anchor", value);
				}
				return origSetProp(prop, value, priority ?? "");
			};
		}
		return el;
	}) as typeof document.createElementNS;
	return () => {
		document.createElementNS = origCreateElementNS;
	};
}

/** エディタ設定に合わせたフォントファミリーを返す */
function getMermaidFontFamily(): string {
	return FONT_FAMILY_MAP[useSettingsStore.getState().fontFamily];
}

/** エディタ設定に合わせたフォントサイズを返す */
function getMermaidFontSize(): string {
	return `${useSettingsStore.getState().fontSize}px`;
}

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

const FONT_SIZE_RE = /font-size\s*:\s*([\d.]+)(px)?/g;

/** SVG 内の全 font-size（CSS `<style>`・属性・インラインスタイル）を ratio 倍に縮小する */
function shrinkFontSizes(svgEl: Element, ratio: number): void {
	const replacer = (_: string, size: string, unit?: string) =>
		`font-size: ${(Number.parseFloat(size) * ratio).toFixed(1)}${unit || "px"}`;

	const styleEl = svgEl.querySelector("style");
	if (styleEl?.textContent) {
		styleEl.textContent = styleEl.textContent.replace(FONT_SIZE_RE, replacer);
	}
	for (const el of svgEl.querySelectorAll("[font-size]")) {
		const fs = el.getAttribute("font-size");
		if (!fs) continue;
		const px = Number.parseFloat(fs);
		if (px > 0) {
			el.setAttribute("font-size", `${(px * ratio).toFixed(1)}px`);
		}
	}
	for (const el of svgEl.querySelectorAll("[style]")) {
		const style = el.getAttribute("style") ?? "";
		if (!style.includes("font-size")) continue;
		el.setAttribute("style", style.replace(FONT_SIZE_RE, replacer));
	}
}

/**
 * サニタイズ済み SVG 文字列を一時的に DOM に挿入し、promoteMermaidStyles を適用して
 * text-anchor をプレゼンテーション属性に焼き込み、CSS の text-anchor 宣言を除去する。
 *
 * SVG 文字列自体に属性を含めることで、innerHTML パース時に WKWebView が
 * 要素生成と同時に属性を認識する。
 */
function bakeStyledSvg(svgString: string): string {
	if (!svgString.includes("<svg")) return svgString;

	const container = document.createElement("div");
	container.innerHTML = svgString;
	const svgEl = container.querySelector("svg");
	if (!svgEl) return svgString;

	promoteMermaidStyles(svgEl);

	// WKWebView tauri:// でフォントメトリクスが微妙に異なりテキストがはみ出す。
	// font-size を縮小して rect サイズはそのままにテキスト幅を縮小する。
	if (isTauriProtocol) {
		shrinkFontSizes(svgEl, 0.85);
	}

	return container.innerHTML;
}

interface FontSnapshot {
	fontFamily: string;
	fontSize: number;
}

function takeFontSnapshot(): FontSnapshot {
	return {
		fontFamily: getMermaidFontFamily(),
		fontSize: useSettingsStore.getState().fontSize,
	};
}

function buildConfig(theme: "light" | "dark", font: FontSnapshot) {
	return {
		startOnLoad: false,
		securityLevel: "strict" as const,
		theme: getMermaidTheme(theme),
		themeCSS: getThemeCss(theme),
		fontFamily: font.fontFamily,
		fontSize: font.fontSize,
		// WKWebView tauri:// では foreignObject のテキスト計測が不正確なため無効化
		htmlLabels: isTauriProtocol ? false : undefined,
		flowchart: {
			nodeSpacing: 40,
			rankSpacing: 40,
			padding: 15,
			diagramPadding: 8,
		},
		sequence: {
			diagramMarginX: 25,
			diagramMarginY: 5,
			actorMargin: 30,
			boxMargin: 10,
			boxTextMargin: 5,
			messageMargin: 28,
		},
		// WKWebView tauri:// のフォントメトリクス差異による
		// テキストはみ出しを防ぐためパディングを増やす。
		...(isTauriProtocol && {
			er: {
				entityPadding: 20,
				minEntityWidth: 100,
			},
			class: {
				padding: 10,
			},
		}),
	};
}

async function ensureInitialized(theme: "light" | "dark", font: FontSnapshot): Promise<void> {
	if (!mermaidModule) {
		if (!initPromise) {
			initPromise = import("mermaid").then((m) => {
				mermaidModule = m;
			});
		}
		await initPromise;
	}
	if (mermaidModule) {
		mermaidModule.default.initialize(buildConfig(theme, font));
	}
}

function cacheKey(source: string, theme: "light" | "dark", font: FontSnapshot): string {
	return `${theme}:${font.fontFamily}:${font.fontSize}:${source}`;
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
	const font = takeFontSnapshot();
	const key = cacheKey(source, theme, font);
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
				await ensureInitialized(theme, font);
				const id = `mermaid-${idCounter++}`;

				const unpatch = isTauriProtocol ? patchTextAnchor() : null;
				let rawSvg: string;
				try {
					const result = await mermaidModule?.default.render(id, source);
					rawSvg = result?.svg ?? "";
				} finally {
					unpatch?.();
				}
				const svg = bakeStyledSvg(sanitizeMermaidSvg(rawSvg));
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
	return cache.get(cacheKey(source, theme, takeFontSnapshot()));
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
 * CSS プロパティのうち、同名の SVG プレゼンテーション属性が存在するもの。
 * WKWebView の `tauri://` 環境では、SVG の CSS が一律に無効になるわけではないが、
 * 一部のプロパティ（特に `text-anchor` など）が `<style>` / インラインスタイル経由だと
 * 安定してレンダリングに反映されないことがある。プレゼンテーション属性は CSS エンジンを
 * 経由せず SVG レンダラが直接処理するため、属性化できるものはそちらを優先して反映する。
 */
const SVG_PRESENTATION_PROPS = new Set([
	"fill",
	"fill-opacity",
	"fill-rule",
	"stroke",
	"stroke-width",
	"stroke-dasharray",
	"stroke-dashoffset",
	"stroke-linecap",
	"stroke-linejoin",
	"stroke-opacity",
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"text-anchor",
	"dominant-baseline",
	"opacity",
	"paint-order",
	"text-decoration",
	"visibility",
]);

/** インラインスタイル文字列から SVG プレゼンテーション属性値を抽出する事前コンパイル済み正規表現 */
const STYLE_PROP_RE = new Map<string, RegExp>(
	[...SVG_PRESENTATION_PROPS].map((p) => [p, new RegExp(`(?:^|;)\\s*${p}:\\s*([^;]+)`)]),
);

/**
 * Mermaid SVG のスタイルを WKWebView tauri:// 対応に変換する。
 *
 * WKWebView tauri:// の SVG CSS 処理:
 * - fill, stroke, font 等: `<style>` タグの CSS ルールが**正常に機能する**
 * - text-anchor: CSS（`<style>` タグ・インラインスタイル共に）が**機能しない**
 *
 * 対策:
 * 1. `<style>` は残す（fill/stroke/font の CSS は正常に動作するため）
 * 2. text-anchor だけ `<style>` とインラインスタイルから除去し、プレゼンテーション
 *    属性に移す。CSS/インラインを除去することで、プレゼンテーション属性が
 *    text-anchor の唯一のソースになり、WKWebView が属性値を使用する。
 * 3. d3.style() で設定されたインラインスタイルをプレゼンテーション属性に変換
 *    （text-anchor 以外も WKWebView のフォールバックとして）
 */
export function promoteMermaidStyles(svgEl: Element): void {
	const styleEl = svgEl.querySelector("style");

	// ── CSS <style> ルール展開（<style> がある場合のみ） ──
	let cssParsed = false;
	if (styleEl?.textContent) {
		const svgId = svgEl.getAttribute("id") ?? "";
		const idPattern = svgId
			? new RegExp(`#${svgId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "g")
			: null;

		try {
			const sheet = new CSSStyleSheet();
			sheet.replaceSync(styleEl.textContent);
			cssParsed = true;

			for (const rule of sheet.cssRules) {
				if (!(rule instanceof CSSStyleRule)) continue;

				let targets: Element[];
				try {
					const selector = idPattern
						? rule.selectorText.replace(idPattern, "").trim()
						: rule.selectorText;

					if (!selector) {
						targets = [svgEl];
					} else {
						targets = [...svgEl.querySelectorAll(selector)];
						if (svgEl.matches(selector)) targets.push(svgEl);
					}
				} catch {
					continue;
				}

				for (const el of targets) {
					const elStyle = (el as HTMLElement | SVGElement).style;
					for (let i = 0; i < rule.style.length; i++) {
						const prop = rule.style[i];
						const value = rule.style.getPropertyValue(prop);
						if (!elStyle.getPropertyValue(prop)) {
							elStyle.setProperty(prop, value, rule.style.getPropertyPriority(prop));
						}
						if (SVG_PRESENTATION_PROPS.has(prop) && !el.getAttribute(prop)) {
							const inlineVal = elStyle.getPropertyValue(prop);
							el.setAttribute(prop, inlineVal || value);
						}
					}
				}
			}
		} catch {
			// replaceSync に失敗した場合でも後続の処理は続行する
		}
	}

	// d3 の .style() で設定されたインラインスタイルをプレゼンテーション属性に変換。
	// sequenceDiagram のアクター名等は CSS <style> ではなく d3 の .style() で
	// text-anchor 等を設定するため、<style> ルール展開では拾えない。
	// WKWebView tauri:// はインラインスタイルも処理しないため、
	// style 属性文字列をパースしてプレゼンテーション属性にコピーする。
	// インラインスタイル → プレゼンテーション属性変換と text-anchor 除去を1回の走査で処理
	for (const el of svgEl.querySelectorAll("[style]")) {
		let styleAttr = el.getAttribute("style") ?? "";
		// d3.style() で設定されたプレゼンテーション属性をコピー
		for (const [prop, regex] of STYLE_PROP_RE) {
			if (el.getAttribute(prop)) continue;
			const match = styleAttr.match(regex);
			if (match) {
				el.setAttribute(prop, match[1].trim());
			}
		}
		// CSS の text-anchor はカスケードでプレゼンテーション属性を上書きし、
		// WKWebView tauri:// がその CSS 値をレンダリングできないため除去する。
		if (styleAttr.includes("text-anchor")) {
			styleAttr = styleAttr
				.replace(/text-anchor\s*:[^;]+;?/g, "")
				.replace(/;\s*$/, "")
				.trim();
			if (styleAttr) {
				el.setAttribute("style", styleAttr);
			} else {
				el.removeAttribute("style");
			}
		}
	}

	// CSS ルールにマッチしなかった要素用のフォントフォールバック。
	// bakeStyledSvg で縮小済みの font-size を上書きしないようインラインスタイルもチェック。
	const fontFamily = getMermaidFontFamily();
	const fontSize = getMermaidFontSize();
	for (const el of svgEl.querySelectorAll("text, tspan")) {
		if (!el.getAttribute("font-family")) {
			el.setAttribute("font-family", fontFamily);
		}
		const elStyle = (el as HTMLElement | SVGElement).style;
		if (!el.getAttribute("font-size") && !elStyle.getPropertyValue("font-size")) {
			el.setAttribute("font-size", fontSize);
		}
	}
	if (!svgEl.getAttribute("font-family")) {
		svgEl.setAttribute("font-family", fontFamily);
	}
	if (
		!svgEl.getAttribute("font-size") &&
		!(svgEl as HTMLElement | SVGElement).style?.getPropertyValue("font-size")
	) {
		svgEl.setAttribute("font-size", fontSize);
	}

	// CSS パースが成功して text-anchor を属性にミラーできた場合のみ <style> から除去。
	// パース失敗時は <style> を残し、通常ブラウザで CSS text-anchor が機能するようにする。
	if (cssParsed && styleEl?.textContent) {
		styleEl.textContent = styleEl.textContent.replace(/text-anchor\s*:[^;]+;?/g, "");
	}
}
