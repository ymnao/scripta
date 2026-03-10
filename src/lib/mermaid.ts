type CacheEntry =
	| { status: "rendering" }
	| { status: "rendered"; svg: string }
	| { status: "error"; message: string };

const cache = new Map<string, CacheEntry>();

let mermaidModule: typeof import("mermaid") | null = null;
let initPromise: Promise<void> | null = null;
let idCounter = 0;

function getMermaidTheme(theme: "light" | "dark"): string {
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
	if (mermaidModule && !initPromise) {
		mermaidModule.default.initialize(buildConfig(theme));
		return;
	}
	if (initPromise) {
		await initPromise;
		mermaidModule?.default.initialize(buildConfig(theme));
		return;
	}
	initPromise = (async () => {
		mermaidModule = await import("mermaid");
		mermaidModule.default.initialize(buildConfig(theme));
	})();
	await initPromise;
}

function cacheKey(source: string, theme: "light" | "dark"): string {
	return `${theme}:${source}`;
}

/**
 * Mermaid ソースコードを SVG 文字列にレンダリングする。
 * 動的 import でバンドルサイズを軽減し、結果をキャッシュする。
 */
export async function renderMermaid(source: string, theme: "light" | "dark"): Promise<string> {
	const key = cacheKey(source, theme);
	const cached = cache.get(key);
	if (cached?.status === "rendered") return cached.svg;
	if (cached?.status === "error") throw new Error(cached.message);

	cache.set(key, { status: "rendering" });

	try {
		await ensureInitialized(theme);
		const id = `mermaid-${idCounter++}`;
		const result = await mermaidModule?.default.render(id, source);
		const svg = result?.svg ?? "";
		cache.set(key, { status: "rendered", svg });
		return svg;
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		cache.set(key, { status: "error", message });
		throw e;
	}
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
	cache.clear();
}
