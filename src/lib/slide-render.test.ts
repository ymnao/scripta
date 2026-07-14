import { beforeEach, describe, expect, it, vi } from "vitest";

// mermaid をモックして SVG 出力を決定的にする (lib/mermaid.test.ts と同パターン)
const renderSpy = vi.fn(async (_id: string, source: string) => {
	if (source.includes("FAIL")) throw new Error("mermaid parse error");
	return { svg: `<svg data-source="${source.replace(/"/g, "&quot;")}"></svg>` };
});
const initializeSpy = vi.fn();

vi.mock("mermaid", () => {
	return {
		default: {
			initialize: initializeSpy,
			render: renderSpy,
		},
	};
});

const { renderSlideHtmlWithMermaid } = await import("./slide-render");
const { clearMermaidCache } = await import("./mermaid");

beforeEach(() => {
	clearMermaidCache();
	renderSpy.mockClear();
	initializeSpy.mockClear();
});

describe("renderSlideHtmlWithMermaid: mermaid fence 変換", () => {
	it("mermaid fenced code を SVG に置換して mermaid-diagram wrapper に格納する", async () => {
		const md = "# Title\n\n```mermaid\ngraph TD\n  A-->B\n```\n";
		const html = await renderSlideHtmlWithMermaid(md, null, "light");
		expect(html).toContain("mermaid-diagram");
		expect(html).toContain("<svg");
		// 元の fenced code (```mermaid) は残らない
		expect(html).not.toMatch(/<code[^>]*>graph TD/);
	});

	it("light / dark テーマが initialize に伝搬される (theme=default vs dark)", async () => {
		const md = "```mermaid\ngraph TD\n  X-->Y\n```";
		await renderSlideHtmlWithMermaid(md, null, "light");
		expect(initializeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default" }));
		await renderSlideHtmlWithMermaid(md, null, "dark");
		expect(initializeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
	});

	it("mermaid fence 前の末尾 `---` を除去する", async () => {
		const md = "```mermaid\ngraph TD\n  A-->B\n```\n---";
		const html = await renderSlideHtmlWithMermaid(md, null, "light");
		expect(html).toContain("mermaid-diagram");
		expect(html).not.toContain("<hr");
	});

	it("mermaid render 失敗時は元の fenced code をそのまま HTML 化する (silent 失敗させない)", async () => {
		const md = "before\n\n```mermaid\nFAIL diagram\n```\n\nafter";
		const html = await renderSlideHtmlWithMermaid(md, null, "light");
		expect(html).not.toContain("mermaid-diagram");
		// preprocess は match ごとの try/catch で元コードを保持 → markdownToHtml が code block 化
		expect(html).toContain("FAIL diagram");
		expect(html).toContain("before");
		expect(html).toContain("after");
	});

	it("options.mermaidOptions を preprocessMermaidBlocks 経由で initialize に伝搬する", async () => {
		const md = "```mermaid\ngraph TD\n  A-->B\n```";
		await renderSlideHtmlWithMermaid(md, null, "light", {
			mermaidOptions: { htmlLabels: false, useMaxWidth: false },
		});
		expect(initializeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ htmlLabels: false }));
	});
	// rasterize=true (embedOptions) 経路は svg-rasterize を要するため
	// export.test.ts 側 (svg-rasterize モック済み) の exportSlidesAsPdf テストでカバー。
});
