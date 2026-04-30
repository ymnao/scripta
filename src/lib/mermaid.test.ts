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
const { renderMermaid, getCacheEntry, clearMermaidCache } = await import("./mermaid");

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
});
