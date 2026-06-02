import { describe, expect, it, vi } from "vitest";

// Mock mermaid module
vi.mock("mermaid", () => {
	let idCounter = 0;
	return {
		default: {
			initialize: vi.fn(),
			render: vi.fn(async (_id: string, source: string) => {
				if (source.includes("INVALID")) {
					throw new Error("Parse error");
				}
				idCounter++;
				return { svg: `<svg>mock-${idCounter}</svg>` };
			}),
		},
	};
});

// Import after mock is set up
const { renderMermaid, getCacheEntry, clearMermaidCache, forceVisibleTextInSvg } = await import(
	"./mermaid"
);

describe("renderMermaid", () => {
	it("正常なソースで SVG 文字列を返す", async () => {
		clearMermaidCache();
		const svg = await renderMermaid("graph TD\n  A-->B", "light");
		expect(svg).toContain("<svg");
	});

	it("キャッシュヒット時に同じ結果を返す", async () => {
		clearMermaidCache();
		const source = "graph LR\n  X-->Y";
		const svg1 = await renderMermaid(source, "light");
		const svg2 = await renderMermaid(source, "light");
		expect(svg1).toBe(svg2);
	});

	it("テーマが異なるとキャッシュが分離される", async () => {
		clearMermaidCache();
		const source = "graph TD\n  C-->D";
		await renderMermaid(source, "light");
		const lightEntry = getCacheEntry(source, "light");
		const darkEntry = getCacheEntry(source, "dark");
		expect(lightEntry?.status).toBe("rendered");
		expect(darkEntry).toBeUndefined();
	});

	it("構文エラーで例外を投げてエラーキャッシュに記録する", async () => {
		clearMermaidCache();
		const source = "INVALID syntax";
		await expect(renderMermaid(source, "light")).rejects.toThrow("Parse error");
		const entry = getCacheEntry(source, "light");
		expect(entry?.status).toBe("error");
	});

	it("clearMermaidCache でキャッシュが空になる", async () => {
		const source = "graph TD\n  E-->F";
		await renderMermaid(source, "light");
		expect(getCacheEntry(source, "light")).toBeDefined();
		clearMermaidCache();
		expect(getCacheEntry(source, "light")).toBeUndefined();
	});

	it("options 指定時は initialize に htmlLabels / useMaxWidth を波及させる (#106)", async () => {
		clearMermaidCache();
		const mermaidMod = (await import("mermaid")).default;
		const initSpy = mermaidMod.initialize as ReturnType<typeof vi.fn>;
		initSpy.mockClear();

		await renderMermaid("graph TD\n  X-->Y", "light", {
			htmlLabels: false,
			useMaxWidth: false,
		});

		// 直近の initialize 呼び出しで主要な diagram type に false が伝播
		expect(initSpy).toHaveBeenCalled();
		// biome-ignore lint/suspicious/noExplicitAny: test internal config shape
		const config = initSpy.mock.calls.at(-1)?.[0] as any;
		// mermaid v11: top-level htmlLabels が new、flowchart.htmlLabels は deprecated
		// 互換性のため両方セット
		expect(config.htmlLabels).toBe(false);
		expect(config.flowchart.htmlLabels).toBe(false);
		expect(config.flowchart.useMaxWidth).toBe(false);
		expect(config.sequence.useMaxWidth).toBe(false);
		expect(config.classDiagram.htmlLabels).toBe(false);
		expect(config.classDiagram.useMaxWidth).toBe(false);
		expect(config.stateDiagram.htmlLabels).toBe(false);
		expect(config.gantt.useMaxWidth).toBe(false);
	});

	it("options 既定時は htmlLabels / useMaxWidth が true（画面プレビュー向け）", async () => {
		clearMermaidCache();
		const mermaidMod = (await import("mermaid")).default;
		const initSpy = mermaidMod.initialize as ReturnType<typeof vi.fn>;
		initSpy.mockClear();

		await renderMermaid("graph TD\n  P-->Q", "light");

		const config = initSpy.mock.calls.at(-1)?.[0] as Record<string, Record<string, unknown>>;
		expect(config.flowchart.htmlLabels).toBe(true);
		expect(config.flowchart.useMaxWidth).toBe(true);
	});

	it("htmlLabels=false 時は themeVariables / themeCSS でラベル fill を強制する (#106, mermaid#885)", async () => {
		clearMermaidCache();
		const mermaidMod = (await import("mermaid")).default;
		const initSpy = mermaidMod.initialize as ReturnType<typeof vi.fn>;
		initSpy.mockClear();

		await renderMermaid("graph TD\n  R-->S", "light", {
			htmlLabels: false,
			useMaxWidth: false,
		});

		const config = initSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		// theme variable で nodeTextColor / textColor / titleColor を明示
		const themeVariables = config.themeVariables as Record<string, string> | undefined;
		expect(themeVariables).toBeDefined();
		expect(themeVariables?.textColor).toBe("#1a1a1a");
		expect(themeVariables?.nodeTextColor).toBe("#1a1a1a");
		expect(themeVariables?.titleColor).toBe("#1a1a1a");
		// CSS で .label text / .nodeLabel 系の fill を強制（belt-and-suspenders）
		const themeCSS = config.themeCSS as string;
		expect(themeCSS).toContain(".label text");
		expect(themeCSS).toContain(".nodeLabel");
		expect(themeCSS).toContain(".edgeLabel");
		expect(themeCSS).toContain("fill: #1a1a1a");
	});

	it("default モード（htmlLabels 未指定）では themeVariables 上書きが無い", async () => {
		clearMermaidCache();
		const mermaidMod = (await import("mermaid")).default;
		const initSpy = mermaidMod.initialize as ReturnType<typeof vi.fn>;
		initSpy.mockClear();

		await renderMermaid("graph TD\n  J-->K", "light");

		const config = initSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		// themeVariables 未指定 → mermaid の theme デフォルト値が使われる
		expect(config.themeVariables).toBeUndefined();
		// themeCSS は sequence diagram の stroke 設定のみ（label fill rule は含まれない）
		const themeCSS = config.themeCSS as string;
		expect(themeCSS).not.toContain(".nodeLabel");
		expect(themeCSS).toContain("messageText");
	});

	it("options が異なるとキャッシュも分離される (#106)", async () => {
		clearMermaidCache();
		const source = "graph TD\n  M-->N";
		await renderMermaid(source, "light"); // 既定
		await renderMermaid(source, "light", { htmlLabels: false, useMaxWidth: false }); // export モード

		// 同じ source / theme でも options が違えば独立キャッシュ
		const defaultEntry = getCacheEntry(source, "light");
		const exportEntry = getCacheEntry(source, "light", {
			htmlLabels: false,
			useMaxWidth: false,
		});
		expect(defaultEntry?.status).toBe("rendered");
		expect(exportEntry?.status).toBe("rendered");
		if (defaultEntry?.status === "rendered" && exportEntry?.status === "rendered") {
			// SVG body は別 id（idCounter）になる
			expect(defaultEntry.svg).not.toBe(exportEntry.svg);
		}
	});
});

describe("forceVisibleTextInSvg (#106 最終防衛線)", () => {
	it("全 <text> 要素に fill 属性を注入する（light theme: #1a1a1a）", () => {
		const svg = '<svg><text x="10" y="20">Hello</text></svg>';
		const out = forceVisibleTextInSvg(svg, "light");
		expect(out).toContain('fill="#1a1a1a"');
		expect(out).toContain("Hello");
	});

	it("dark theme では fill #d4d4d4 を注入する", () => {
		const svg = '<svg><text x="0" y="0">X</text></svg>';
		const out = forceVisibleTextInSvg(svg, "dark");
		expect(out).toContain('fill="#d4d4d4"');
	});

	it("既存の fill 属性は除去してから注入する（重複回避）", () => {
		const svg = '<svg><text fill="white" x="0" y="0">Y</text></svg>';
		const out = forceVisibleTextInSvg(svg, "light");
		expect(out).not.toContain('fill="white"');
		expect(out.match(/fill=/g)?.length).toBe(1);
		expect(out).toContain('fill="#1a1a1a"');
	});

	it("インライン style の fill / color は除去してから fill 属性を注入する", () => {
		const svg = '<svg><text style="fill: white; font-size: 12px;">Z</text></svg>';
		const out = forceVisibleTextInSvg(svg, "light");
		expect(out).not.toMatch(/fill:\s*white/);
		expect(out).toContain("font-size: 12px");
		expect(out).toContain('fill="#1a1a1a"');
	});

	it("<tspan> 要素も対象（改行ラベルで使われる）", () => {
		const svg = "<svg><text><tspan>line1</tspan><tspan>line2</tspan></text></svg>";
		const out = forceVisibleTextInSvg(svg, "light");
		// text + tspan 2 個 = 3 個の fill 注入
		expect(out.match(/fill="#1a1a1a"/g)?.length).toBe(3);
	});

	it("text を含まない SVG は変更しない", () => {
		const svg = "<svg><rect/><path/></svg>";
		expect(forceVisibleTextInSvg(svg, "light")).toBe(svg);
	});

	it("複数の text 要素に全て注入する", () => {
		const svg = "<svg><text>A</text><text>B</text><text>C</text></svg>";
		const out = forceVisibleTextInSvg(svg, "light");
		expect(out.match(/fill="#1a1a1a"/g)?.length).toBe(3);
	});
});
