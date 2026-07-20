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

		// 直近の initialize 呼び出しで mermaid v11 の **正規 key** に false が伝播
		expect(initSpy).toHaveBeenCalled();
		// biome-ignore lint/suspicious/noExplicitAny: test internal config shape
		const config = initSpy.mock.calls.at(-1)?.[0] as any;
		// top-level htmlLabels（v11 正規）
		expect(config.htmlLabels).toBe(false);
		// 主要 diagram type の useMaxWidth 波及（authoritative key 名で assert）
		expect(config.flowchart.useMaxWidth).toBe(false);
		expect(config.sequence.useMaxWidth).toBe(false);
		expect(config.class.useMaxWidth).toBe(false);
		expect(config.state.useMaxWidth).toBe(false);
		expect(config.gantt.useMaxWidth).toBe(false);
		expect(config.er.useMaxWidth).toBe(false);
		// class は htmlLabels も持つ（ClassDiagramConfig インタフェース）
		expect(config.class.htmlLabels).toBe(false);
		// regression guard: 旧 commit の wrong key（classDiagram / stateDiagram）が
		// 復活していないことを確認。これらは mermaid v11 の MermaidConfig には存在せず、
		// 設定しても silent に無視されて useMaxWidth: false が効かないという #106 の
		// High 優先度バグの原因だった。
		expect(config.classDiagram).toBeUndefined();
		expect(config.stateDiagram).toBeUndefined();
	});

	it("options 既定時は htmlLabels / useMaxWidth が true（画面プレビュー向け）", async () => {
		clearMermaidCache();
		const mermaidMod = (await import("mermaid")).default;
		const initSpy = mermaidMod.initialize as ReturnType<typeof vi.fn>;
		initSpy.mockClear();

		await renderMermaid("graph TD\n  P-->Q", "light");

		// biome-ignore lint/suspicious/noExplicitAny: test internal config shape
		const config = initSpy.mock.calls.at(-1)?.[0] as any;
		// htmlLabels は v11 推奨の top-level だけで指定（mermaid 既定 true 相当）
		expect(config.htmlLabels).toBe(true);
		expect(config.flowchart.useMaxWidth).toBe(true);
		// 一部 type の useMaxWidth が true で波及していることを確認
		expect(config.class.useMaxWidth).toBe(true);
		expect(config.state.useMaxWidth).toBe(true);
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

	it("signal が事前に abort されていれば AbortError を throw し mermaid を呼ばない (cache miss)", async () => {
		clearMermaidCache();
		const mermaidMod = (await import("mermaid")).default;
		const renderSpy = mermaidMod.render as ReturnType<typeof vi.fn>;
		renderSpy.mockClear();
		const controller = new AbortController();
		controller.abort();
		await expect(
			renderMermaid("graph TD\n  Z-->W", "light", {}, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(renderSpy).not.toHaveBeenCalled();
	});

	it("pre-aborted signal でも cache rendered hit は既存 SVG を返す (poisoning 防止)", async () => {
		clearMermaidCache();
		const source = "graph TD\n  H-->I";
		// 先に成功させて cache に "rendered" を作る
		const firstSvg = await renderMermaid(source, "light");
		expect(getCacheEntry(source, "light")?.status).toBe("rendered");
		const mermaidMod = (await import("mermaid")).default;
		const renderSpy = mermaidMod.render as ReturnType<typeof vi.fn>;
		renderSpy.mockClear();
		// 2 回目は pre-aborted signal で呼ぶ → cache hit のため throw せず SVG を返す
		const controller = new AbortController();
		controller.abort();
		const cachedSvg = await renderMermaid(source, "light", {}, controller.signal);
		expect(cachedSvg).toBe(firstSvg);
		expect(renderSpy).not.toHaveBeenCalled();
	});

	it("rendering 中の共有 promise は pre-aborted caller に対しても reject せず健常 caller の結果を届ける", async () => {
		clearMermaidCache();
		const source = "graph TD\n  J-->L";
		const mermaidMod = (await import("mermaid")).default;
		const renderSpy = mermaidMod.render as ReturnType<typeof vi.fn>;
		renderSpy.mockClear();
		// 健常 caller が先に起動 → cache に "rendering" が入る
		const healthyPromise = renderMermaid(source, "light");
		// 共有 promise を掴む後発 caller (pre-aborted) は「cache hit rendering」経路を通り
		// 実 render は 1 回のみ、両 caller が同じ SVG を得る
		const controller = new AbortController();
		controller.abort();
		const abortedCallerPromise = renderMermaid(source, "light", {}, controller.signal);
		const [healthy, abortedCaller] = await Promise.all([healthyPromise, abortedCallerPromise]);
		expect(healthy).toBe(abortedCaller);
		expect(renderSpy).toHaveBeenCalledTimes(1);
	});

	it("init 失敗 (initialize throw) は per-source error として cache されない (#312 追跡 fix)", async () => {
		clearMermaidCache();
		const source = "graph TD\n  INIT-->FAIL";
		const mermaidMod = (await import("mermaid")).default;
		const initSpy = mermaidMod.initialize as ReturnType<typeof vi.fn>;
		// 直前 test で lastInitKey が固定される可能性を排して、必ず initialize が
		// 呼ばれる状況を作る (theme を切り替える): 続く 1 回だけ throw させる
		initSpy.mockImplementationOnce(() => {
			throw new Error("init failure");
		});
		await expect(renderMermaid(source, "dark")).rejects.toThrow("init failure");
		// per-source error entry が書き込まれていないことを検証 (書き込まれると次回 call が
		// 短絡し、ensureInitialized 内の initPromise=null リセット経由の再 import に到達しない)
		const entry = getCacheEntry(source, "dark");
		expect(entry).toBeUndefined();
	});

	it("init 失敗後の再 call が新規 render を試みる (retry 経路が生きている)", async () => {
		clearMermaidCache();
		const source = "graph TD\n  RETRY-->OK";
		const mermaidMod = (await import("mermaid")).default;
		const initSpy = mermaidMod.initialize as ReturnType<typeof vi.fn>;
		const renderSpy = mermaidMod.render as ReturnType<typeof vi.fn>;
		renderSpy.mockClear();
		initSpy.mockImplementationOnce(() => {
			throw new Error("transient init failure");
		});
		// 1 回目: init 失敗で reject
		await expect(renderMermaid(source, "dark")).rejects.toThrow("transient init failure");
		expect(renderSpy).not.toHaveBeenCalled();
		// 2 回目: initialize が正常復帰 → 実 render に到達し SVG を得る
		const svg = await renderMermaid(source, "dark");
		expect(svg).toContain("<svg");
		expect(renderSpy).toHaveBeenCalledTimes(1);
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
