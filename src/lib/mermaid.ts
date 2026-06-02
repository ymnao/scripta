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

let mermaidModule: typeof import("mermaid") | null = null;
let initPromise: Promise<void> | null = null;
let idCounter = 0;
/** 最後に initialize() に渡した設定のキー。変更がなければ再初期化をスキップする。 */
let lastInitKey = "";
/** initialize+render をアトミックに直列化するキュー */
let renderQueue: Promise<void> = Promise.resolve();

/** エディタ設定に合わせたフォントファミリーを返す */
function getMermaidFontFamily(): string {
	return FONT_FAMILY_MAP[useSettingsStore.getState().fontFamily];
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

/**
 * `htmlLabels: false` で flowchart / classDiagram / stateDiagram のラベルが
 * SVG `<text>` で描画されるが、mermaid v11 で `options.nodeTextColor || options.textColor`
 * テーマ変数 fallback chain が undefined / 同色値に解決され、印刷経路で **ラベル全消失**
 * する既知挙動がある（mermaid-js/mermaid#885）。
 *
 * - `themeVariables`: mermaid の getStyles テンプレートに渡る生の値を上書き
 *   → `${options.nodeTextColor}` 補間が確実な dark color になる
 * - `themeCSS`: 上記の theme variable 解決が壊れた場合の belt-and-suspenders。
 *   `.label text` / `.nodeLabel` 等の selector で fill を強制
 */
function getInvisibleLabelOverrides(theme: "light" | "dark"): {
	themeVariables: { textColor: string; nodeTextColor: string; titleColor: string };
	css: string;
} {
	const textColor = theme === "dark" ? "#d4d4d4" : "#1a1a1a";
	return {
		themeVariables: {
			textColor,
			nodeTextColor: textColor,
			titleColor: textColor,
		},
		css: `
.label text,
.nodeLabel,
.nodeLabel tspan,
.cluster-label text,
.edgeLabel,
.titleText,
text.actor-text,
text.actor {
  fill: ${textColor};
}
.label,
.nodeLabel,
.edgeLabel {
  color: ${textColor};
}
`,
	};
}

function getThemeCss(theme: "light" | "dark", options: MermaidRenderOptions): string {
	// ライト: 白い縁取り（暗い文字を際立たせる）
	// ダーク: 暗い縁取り（明るい文字を明るい rect 上でも読めるようにする）
	const strokeColor = theme === "dark" ? "#1a1a2e" : "#ffffff";
	let css = `${THEME_CSS} text.messageText, text.noteText, text.labelText, text.loopText { stroke: ${strokeColor}; }`;

	if (options.htmlLabels === false) {
		css += getInvisibleLabelOverrides(theme).css;
	}

	return css;
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

/**
 * 描画モードオプション。デフォルト（両方 undefined / true）は画面プレビュー向け。
 * PDF export 側では `{ htmlLabels: false, useMaxWidth: false }` を指定して、
 * Chromium の printToPDF 経路で **ノードラベル消失**（foreignObject 不可視）と
 * **SVG 高さ 0 への潰れ**（width=100% + height=auto + viewBox の既知挙動）を回避する（#106）。
 */
export interface MermaidRenderOptions {
	/** Flowchart / classDiagram / stateDiagram のノードラベルを SVG `<text>` で描画する。
	 * 既定 `true`（HTML `<foreignObject>` でリッチに描画）。PDF 出力では `false` 必須。 */
	htmlLabels?: boolean;
	/** SVG の自動サイズ調整（`width="100%"` + style max-width）を無効化する。
	 * 既定 `true`（コンテナにフィット）。PDF 出力では `false` で intrinsic 寸法を出させる。 */
	useMaxWidth?: boolean;
}

function applyOptionFlags(options: MermaidRenderOptions): {
	htmlLabels: boolean;
	useMaxWidth: boolean;
} {
	return {
		htmlLabels: options.htmlLabels ?? true,
		useMaxWidth: options.useMaxWidth ?? true,
	};
}

function buildConfig(theme: "light" | "dark", font: FontSnapshot, options: MermaidRenderOptions) {
	const { htmlLabels, useMaxWidth } = applyOptionFlags(options);
	// htmlLabels: false の SVG <text> 不可視対策の theme variable 上書き（mermaid#885）
	const labelOverrides =
		options.htmlLabels === false ? getInvisibleLabelOverrides(theme) : undefined;
	return {
		startOnLoad: false,
		securityLevel: "strict" as const,
		theme: getMermaidTheme(theme),
		themeVariables: labelOverrides?.themeVariables,
		themeCSS: getThemeCss(theme, options),
		fontFamily: font.fontFamily,
		fontSize: font.fontSize,
		// mermaid v11 で `flowchart.htmlLabels` は DEPRECATED → 新しいのはトップレベル
		// `htmlLabels`。`getEffectiveHtmlLabels` の解決は
		// `config.htmlLabels ?? config.flowchart?.htmlLabels ?? true` なので、
		// 両方明示すれば deprecation 警告も消えるし、両方経路で確実に false が伝わる。
		htmlLabels,
		flowchart: {
			nodeSpacing: 40,
			rankSpacing: 40,
			padding: 15,
			diagramPadding: 8,
			htmlLabels,
			useMaxWidth,
		},
		sequence: {
			diagramMarginX: 25,
			diagramMarginY: 5,
			actorMargin: 30,
			boxMargin: 10,
			boxTextMargin: 5,
			messageMargin: 28,
			useMaxWidth,
		},
		// 主要な diagram タイプにも useMaxWidth / htmlLabels を波及。
		// 未列挙の type は mermaid 既定（useMaxWidth: true）になり PDF で width=100% が
		// 残る可能性があるが、利用頻度の低い type は様子見で十分（#106 範囲）。
		classDiagram: { htmlLabels, useMaxWidth },
		stateDiagram: { htmlLabels, useMaxWidth },
		gantt: { useMaxWidth },
		journey: { useMaxWidth },
		pie: { useMaxWidth },
		er: { useMaxWidth },
		c4: { useMaxWidth },
		gitGraph: { useMaxWidth },
		mindmap: { useMaxWidth },
		requirement: { useMaxWidth },
	};
}

async function ensureInitialized(
	theme: "light" | "dark",
	font: FontSnapshot,
	options: MermaidRenderOptions,
): Promise<void> {
	if (!mermaidModule) {
		if (!initPromise) {
			initPromise = import("mermaid").then((m) => {
				mermaidModule = m;
			});
		}
		await initPromise;
	}
	if (mermaidModule) {
		const { htmlLabels, useMaxWidth } = applyOptionFlags(options);
		const key = `${theme}:${font.fontFamily}:${font.fontSize}:${htmlLabels}:${useMaxWidth}`;
		if (key !== lastInitKey) {
			mermaidModule.default.initialize(buildConfig(theme, font, options));
			lastInitKey = key;
		}
	}
}

function cacheKey(
	source: string,
	theme: "light" | "dark",
	font: FontSnapshot,
	options: MermaidRenderOptions,
): string {
	const { htmlLabels, useMaxWidth } = applyOptionFlags(options);
	return `${theme}:${font.fontFamily}:${font.fontSize}:${htmlLabels ? 1 : 0}:${useMaxWidth ? 1 : 0}:${source}`;
}

/**
 * SVG 内の全ての `<text>` / `<tspan>` 要素に明示的な `fill` 属性を直接注入する。
 * mermaid#885 の text 不可視問題に対する **最終防衛線**:
 * - themeVariables override が mermaid 内部で打ち消されるケース
 * - themeCSS が mermaid 生成 CSS より前に出力されて specificity / source order で負けるケース
 * - selector がカバーしていない diagram type（例: sequence の `.actor-text`）
 * これら全てを無視して、`<text>` 要素レベルで `fill` を強制する。
 *
 * 既存の `fill` 属性 / `style="fill:..."` インラインスタイルは除去してから注入する
 * （重複・矛盾回避）。`<tspan>` も対象（mermaid のラベル改行で使われる）。
 */
export function forceVisibleTextInSvg(svg: string, theme: "light" | "dark"): string {
	const fillColor = theme === "dark" ? "#d4d4d4" : "#1a1a1a";
	return svg.replace(/<(text|tspan)\b([^>]*?)>/g, (_full, tag: string, rawAttrs: string) => {
		// 既存 fill 属性を除去
		let attrs = rawAttrs.replace(/\s+fill\s*=\s*"[^"]*"/g, "");
		// インライン style の fill / color を除去
		attrs = attrs.replace(/\s+style\s*=\s*"([^"]*)"/g, (_s, styleVal: string) => {
			const filtered = styleVal
				.split(";")
				.map((p) => p.trim())
				.filter((p) => p && !/^(fill|color)\b/i.test(p))
				.join("; ");
			return filtered ? ` style="${filtered}"` : "";
		});
		return `<${tag}${attrs} fill="${fillColor}">`;
	});
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
 * 同一 (source, theme, fontFamily, fontSize, options) の重複呼び出しは Promise を共有し、
 * initialize+render は排他キューで直列化してテーマ・フォント設定の競合を防ぐ。
 *
 * `options` を渡すと別キャッシュエントリ・別 init key として扱われる。
 * 画面プレビューは options 省略（既定: htmlLabels=true, useMaxWidth=true）で呼び、
 * PDF export は `{ htmlLabels: false, useMaxWidth: false }` を渡す（#106）。
 */
export async function renderMermaid(
	source: string,
	theme: "light" | "dark",
	options: MermaidRenderOptions = {},
): Promise<string> {
	const font = takeFontSnapshot();
	const key = cacheKey(source, theme, font, options);
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
				await ensureInitialized(theme, font, options);
				const id = `mermaid-${idCounter++}`;

				const result = await mermaidModule?.default.render(id, source);
				const rawSvg = result?.svg ?? "";
				const sanitized = sanitizeMermaidSvg(rawSvg);
				// PDF export 経路（htmlLabels: false）では、themeVariables / themeCSS の
				// theme variable 解決が壊れて SVG <text> が透明 / 同色化する case が残る
				// （mermaid#885）。SVG postprocess で <text> / <tspan> の fill 属性を
				// 直接注入する最終防衛線（CSS specificity / theme 解決順序を無視できる）。
				const svg =
					options.htmlLabels === false ? forceVisibleTextInSvg(sanitized, theme) : sanitized;
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
 * `options` は `renderMermaid` 呼び出し時と同じ値で照会すること（既定同士なら一致）。
 */
export function getCacheEntry(
	source: string,
	theme: "light" | "dark",
	options: MermaidRenderOptions = {},
): CacheEntry | undefined {
	return cache.get(cacheKey(source, theme, takeFontSnapshot(), options));
}

/**
 * テーマ変更時にキャッシュをクリアする。
 */
export function clearMermaidCache(): void {
	cacheGeneration++;
	cache.clear();
	lastInitKey = "";
}
