type CacheEntry =
	| { status: "rendering"; promise: Promise<string> }
	| { status: "rendered"; svg: string }
	| { status: "error"; message: string };

const cache = new Map<string, CacheEntry>();

let mermaidModule: typeof import("mermaid") | null = null;
let initPromise: Promise<void> | null = null;
let idCounter = 0;
/** initialize+render をアトミックに直列化するキュー */
let renderQueue: Promise<void> = Promise.resolve();

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
 * 同一 (source, theme) の重複呼び出しは Promise を共有し、
 * initialize+render は排他キューで直列化してテーマ競合を防ぐ。
 */
export async function renderMermaid(source: string, theme: "light" | "dark"): Promise<string> {
	const key = cacheKey(source, theme);
	const cached = cache.get(key);
	if (cached?.status === "rendered") return cached.svg;
	if (cached?.status === "error") throw new Error(cached.message);
	if (cached?.status === "rendering") return cached.promise;

	const promise = new Promise<string>((resolve, reject) => {
		renderQueue = renderQueue.then(async () => {
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
				const svg = result?.svg ?? "";
				cache.set(key, { status: "rendered", svg });
				resolve(svg);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				cache.set(key, { status: "error", message });
				reject(e);
			}
		});
	});

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
	cache.clear();
}
