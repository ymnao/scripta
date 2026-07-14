import { describe, expect, it, vi } from "vitest";

// mermaid をモックして SVG 出力を決定的にする (lib/mermaid.test.ts と同パターン)
vi.mock("mermaid", () => {
	let idCounter = 0;
	return {
		default: {
			initialize: vi.fn(),
			render: vi.fn(async (_id: string, _source: string) => {
				idCounter++;
				return { svg: `<svg data-testid="mock-mermaid-${idCounter}"></svg>` };
			}),
		},
	};
});

const { renderSlideHtmlWithMermaid } = await import("./slide-render");
const { clearMermaidCache } = await import("./mermaid");

describe("renderSlideHtmlWithMermaid: mermaid fence 変換", () => {
	it("mermaid fenced code を SVG に置換して mermaid-diagram wrapper に格納する", async () => {
		clearMermaidCache();
		const md = "# Title\n\n```mermaid\ngraph TD\n  A-->B\n```\n";
		const html = await renderSlideHtmlWithMermaid(md, null, "light");
		expect(html).toContain("mermaid-diagram");
		expect(html).toContain("<svg");
		// 元の fenced code (```mermaid) は残らない
		expect(html).not.toMatch(/<code[^>]*>graph TD/);
	});

	it("light / dark テーマを preprocessMermaidBlocks に伝搬する (キャッシュが分離される)", async () => {
		clearMermaidCache();
		const md = "```mermaid\ngraph TD\n  X-->Y\n```";
		const lightHtml = await renderSlideHtmlWithMermaid(md, null, "light");
		const darkHtml = await renderSlideHtmlWithMermaid(md, null, "dark");
		// 両方とも SVG 化された HTML を返す
		expect(lightHtml).toContain("mermaid-diagram");
		expect(darkHtml).toContain("mermaid-diagram");
	});

	it("mermaid fence 前の末尾 `---` を除去する", async () => {
		clearMermaidCache();
		const md = "```mermaid\ngraph TD\n  A-->B\n```\n---";
		const html = await renderSlideHtmlWithMermaid(md, null, "light");
		expect(html).toContain("mermaid-diagram");
		expect(html).not.toContain("<hr");
	});
});
