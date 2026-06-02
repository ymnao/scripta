import { version as katexVersion } from "katex/package.json";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("./commands", () => ({
	writeFile: vi.fn().mockResolvedValue(undefined),
	exportPdf: vi.fn().mockResolvedValue(undefined),
	showSaveDialog: vi.fn(),
}));

vi.mock("./mermaid", () => ({
	renderMermaid: vi.fn(async (source: string) => `<svg>${source}</svg>`),
}));

vi.mock("./svg-rasterize", () => ({
	svgToPng: vi.fn(async () => "data:image/png;base64,MOCK"),
}));

const { writeFile, exportPdf, showSaveDialog } = await import("./commands");
const {
	buildHtmlDocument,
	buildPromptFromTemplate,
	exportAsHtml,
	exportAsPdf,
	exportAsPrompt,
	extractSvgNaturalSizeAttrs,
	findMermaidCodeBlocks,
	getDefaultPromptTemplate,
	preprocessMermaidBlocks,
	preprocessPageBreakMarkers,
	wrapSectionsInHtml,
} = await import("./export");

const mockedSave = showSaveDialog as Mock;
const mockedWriteFile = writeFile as Mock;
const mockedExportPdf = exportPdf as Mock;

describe("exportAsHtml", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns false when save dialog is cancelled", async () => {
		mockedSave.mockResolvedValue(null);
		const result = await exportAsHtml("# Hello", "/workspace/test.md");
		expect(result).toBe(false);
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it("writes HTML file on save", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		const result = await exportAsHtml("# Hello", "/workspace/test.md");
		expect(result).toBe(true);
		expect(mockedWriteFile).toHaveBeenCalledWith(
			"/output/test.html",
			expect.stringContaining("<!DOCTYPE html>"),
		);
	});

	it("includes title in HTML document", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		await exportAsHtml("# Hello", "/workspace/my-note.md");
		const html = mockedWriteFile.mock.calls[0][1] as string;
		expect(html).toContain("<title>my-note</title>");
	});

	it("includes KaTeX CDN link in HTML", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		await exportAsHtml("$x^2$", "/workspace/test.md");
		const html = mockedWriteFile.mock.calls[0][1] as string;
		expect(html).toContain("cdn.jsdelivr.net/npm/katex");
	});

	it("syncs KaTeX CSS CDN version with installed katex package (#79)", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		await exportAsHtml("$x^2$", "/workspace/test.md");
		const html = mockedWriteFile.mock.calls[0][1] as string;
		expect(html).toContain(`katex@${katexVersion}/dist/katex.min.css`);
	});

	it("converts markdown content to HTML", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		await exportAsHtml("**bold**", "/workspace/test.md");
		const html = mockedWriteFile.mock.calls[0][1] as string;
		expect(html).toContain("<strong>bold</strong>");
	});

	it("applies light theme when specified", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		await exportAsHtml("# Hello", "/workspace/test.md", { theme: "light" });
		const html = mockedWriteFile.mock.calls[0][1] as string;
		expect(html).toContain("color-scheme: light");
		expect(html).not.toContain("prefers-color-scheme");
	});

	it("applies dark theme when specified", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		await exportAsHtml("# Hello", "/workspace/test.md", { theme: "dark" });
		const html = mockedWriteFile.mock.calls[0][1] as string;
		expect(html).toContain("color-scheme: dark");
		expect(html).toContain("background: #1a1a1a");
		expect(html).not.toContain("prefers-color-scheme");
	});

	it("resolves system theme to light/dark for consistent Mermaid rendering", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		await exportAsHtml("# Hello", "/workspace/test.md");
		const html = mockedWriteFile.mock.calls[0][1] as string;
		// system テーマは Mermaid SVG と合わせるため解決済みテーマ（light）で固定される
		expect(html).toContain("color-scheme: light");
		expect(html).not.toContain("prefers-color-scheme");
	});

	it("includes Mermaid SVG in final HTML output", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		const md = "# Title\n\n```mermaid\ngraph TD\n  A-->B\n```\n\ntext";
		await exportAsHtml(md, "/workspace/test.md");
		const html = mockedWriteFile.mock.calls[0][1] as string;
		expect(html).toContain("<svg>");
		expect(html).toContain("mermaid-diagram");
		expect(html).not.toContain("```mermaid");
	});
});

describe("exportAsPrompt", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns false when save dialog is cancelled", async () => {
		mockedSave.mockResolvedValue(null);
		const result = await exportAsPrompt("# Hello", "/workspace/test.md");
		expect(result).toBe(false);
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it("writes prompt markdown file on save", async () => {
		mockedSave.mockResolvedValue("/output/test-prompt.md");
		const result = await exportAsPrompt("# Hello\n\nWorld", "/workspace/test.md");
		expect(result).toBe(true);
		expect(mockedWriteFile).toHaveBeenCalledWith(
			"/output/test-prompt.md",
			expect.stringContaining("# HTML変換プロンプト"),
		);
	});

	it("includes title and markdown content in prompt", async () => {
		mockedSave.mockResolvedValue("/output/test-prompt.md");
		await exportAsPrompt("# Hello", "/workspace/my-doc.md");
		const output = mockedWriteFile.mock.calls[0][1] as string;
		expect(output).toContain("my-doc");
		expect(output).toContain("# Hello");
	});

	it("wraps markdown content in code block", async () => {
		mockedSave.mockResolvedValue("/output/test-prompt.md");
		await exportAsPrompt("some content", "/workspace/test.md");
		const output = mockedWriteFile.mock.calls[0][1] as string;
		expect(output).toContain("```markdown");
		expect(output).toContain("some content");
	});

	it("uses longer fence when content contains triple backticks", async () => {
		mockedSave.mockResolvedValue("/output/test-prompt.md");
		const md = "Some text\n```js\nconsole.log('hi');\n```\nEnd";
		await exportAsPrompt(md, "/workspace/test.md");
		const output = mockedWriteFile.mock.calls[0][1] as string;
		// Fence must be longer than the 3 backticks in content
		expect(output).toContain("````markdown");
		expect(output).toContain(md);
	});

	it("uses even longer fence for nested fences", async () => {
		mockedSave.mockResolvedValue("/output/test-prompt.md");
		const md = "````\ninner\n````";
		await exportAsPrompt(md, "/workspace/test.md");
		const output = mockedWriteFile.mock.calls[0][1] as string;
		expect(output).toContain("`````markdown");
	});
});

describe("exportAsPdf", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns false when save dialog is cancelled", async () => {
		mockedSave.mockResolvedValue(null);
		const result = await exportAsPdf("# Hello", "/workspace/test.md");
		expect(result).toBe(false);
		expect(mockedExportPdf).not.toHaveBeenCalled();
	});

	it("calls exportPdf command on save", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		const result = await exportAsPdf("# Hello", "/workspace/test.md");
		expect(result).toBe(true);
		expect(mockedExportPdf).toHaveBeenCalledWith(
			expect.stringContaining("<!DOCTYPE html>"),
			"/output/test.pdf",
		);
	});

	it("always uses light theme for PDF", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("color-scheme: light");
		expect(html).not.toContain("prefers-color-scheme");
	});

	it("uses pdf filter for save dialog", async () => {
		mockedSave.mockResolvedValue(null);
		await exportAsPdf("# Hello", "/workspace/test.md");
		expect(mockedSave).toHaveBeenCalledWith(
			expect.objectContaining({
				defaultPath: "test.pdf",
				filters: [{ name: "PDF", extensions: ["pdf"] }],
			}),
		);
	});

	it("includes A4 page size and print margins in PDF HTML", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("size: A4");
		expect(html).toContain("margin: 20mm");
	});

	it("converts single newlines to <br> in PDF HTML", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("line1\nline2", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("<br");
	});

	it("renders KaTeX math in PDF HTML", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("$x^2$", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("katex");
		expect(html).toContain("cdn.jsdelivr.net/npm/katex");
	});

	it("PDF 出力では Mermaid を PNG ラスタライズして <img> として埋め込む (#106)", async () => {
		const { svgToPng } = await import("./svg-rasterize");
		const { renderMermaid } = await import("./mermaid");
		(svgToPng as Mock).mockClear();
		// SVG に明示的な width/height を入れて intrinsic 寸法を返させる
		(renderMermaid as Mock).mockImplementationOnce(
			async () => '<svg width="320" height="240" viewBox="0 0 320 240"><g/></svg>',
		);
		mockedSave.mockResolvedValue("/output/test.pdf");
		const md = "# Title\n\n```mermaid\ngraph TD\n  A-->B\n```\n\ntext";
		await exportAsPdf(md, "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		// SVG 経路ではなく <img src="data:image/png;..."> 経路で埋め込む
		expect(html).toContain('<img src="data:image/png;base64,MOCK"');
		// retina 用の 2x PNG だが、<img> の表示サイズは SVG 自然寸法（1x）にする
		expect(html).toContain('width="320"');
		expect(html).toContain('height="240"');
		expect(html).toContain("mermaid-diagram");
		expect(html).not.toContain("```mermaid");
		expect(svgToPng).toHaveBeenCalled();
	});

	it("PDF HTML には `.mermaid-diagram img` 用の max-width:100% CSS が含まれる", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# x", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		// PNG の <img> が container 幅を超えないように max-width: 100% を CSS で指定
		expect(html).toContain(".mermaid-diagram img { max-width: 100%; height: auto; }");
	});

	it("PDF 出力では Mermaid を htmlLabels=false / useMaxWidth=false で描画する (#106)", async () => {
		const { renderMermaid } = await import("./mermaid");
		(renderMermaid as Mock).mockClear();
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("```mermaid\ngraph TD\n  A-->B\n```", "/workspace/test.md");

		// 印刷経路の foreignObject 不可視 / SVG 高さ 0 を回避するため、
		// renderMermaid の 3 番目の引数で export モード指定を渡す。
		expect(renderMermaid).toHaveBeenCalledWith(expect.any(String), "light", {
			htmlLabels: false,
			useMaxWidth: false,
		});
	});

	it("ラスタライズ失敗時は inline SVG にフォールバックする (#106)", async () => {
		const { svgToPng } = await import("./svg-rasterize");
		(svgToPng as Mock).mockImplementationOnce(() => Promise.reject(new Error("canvas tainted")));
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("```mermaid\ngraph TD\n  A-->B\n```", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		// PNG 経路に失敗したら inline SVG にフォールバック
		expect(html).toContain("<svg>");
		expect(html).toContain("mermaid-diagram");
		expect(html).not.toContain("data:image/png;base64,MOCK");
	});

	it("HTML 出力では Mermaid を inline SVG で埋め込む（PNG ラスタライズしない）", async () => {
		const { renderMermaid } = await import("./mermaid");
		const { svgToPng } = await import("./svg-rasterize");
		(renderMermaid as Mock).mockClear();
		(svgToPng as Mock).mockClear();
		mockedSave.mockResolvedValue("/output/test.html");
		const md = "# Title\n\n```mermaid\ngraph TD\n  A-->B\n```\n\ntext";
		await exportAsHtml(md, "/workspace/test.md");
		const html = mockedWriteFile.mock.calls[0][1] as string;

		// HTML 出力はブラウザで開かれる前提で SVG を inline で保持
		expect(html).toContain("<svg>");
		expect(html).toContain("mermaid-diagram");
		// PNG ラスタライズは呼ばれない（PDF 専用）
		expect(svgToPng).not.toHaveBeenCalled();
		// HTML 出力はリッチな foreignObject ラベル維持（既定: htmlLabels=true）
		expect(renderMermaid).toHaveBeenCalledWith(expect.any(String), expect.any(String), {});
	});

	it("smart=false の force-break CSS が出力される（modern + legacy alias）", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: false,
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		// smart=false: level (h2) と上位 (h1) を force-break
		expect(html).toMatch(/h1, h2 \{[^}]*break-before: page;[^}]*page-break-before: always;/);
	});
});

describe("buildHtmlDocument page break (CSS-only, #93)", () => {
	it("smart=true + level=h1: force-break セレクタは無し（forceLevel=0）", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light", {
			level: "h1",
			smart: true,
		});
		expect(html).not.toMatch(/h[1-6][^{]*\{\s*break-before:\s*page/);
	});

	it("smart=true + level=h2: forceLevel=1 で h1 のみ force-break", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light", {
			level: "h2",
			smart: true,
		});
		expect(html).toMatch(/h1 \{[^}]*break-before: page;[^}]*page-break-before: always;/);
		expect(html).not.toMatch(/h1, h2 \{[^}]*break-before: page/);
	});

	it("smart=true + level=h3: forceLevel=2 で h1, h2 force-break", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light", {
			level: "h3",
			smart: true,
		});
		expect(html).toMatch(/h1, h2 \{[^}]*break-before: page;/);
		expect(html).not.toMatch(/h1, h2, h3 \{[^}]*break-before: page/);
	});

	it("smart=false: level 自身を含めて force-break (旧 aggressive 動作)", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light", {
			level: "h3",
			smart: false,
		});
		expect(html).toMatch(/h1, h2, h3 \{[^}]*break-before: page;/);
	});

	it("level=none: 見出し系の force-break は無し", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light", {
			level: "none",
			smart: true,
		});
		expect(html).not.toMatch(/h[1-6][^{]*\{\s*break-before:\s*page/);
	});

	it("pageBreak undefined: 見出し系の force-break は無し", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light");
		expect(html).not.toMatch(/h[1-6][^{]*\{\s*break-before:\s*page/);
	});

	it("常に widows / orphans / break-after avoid CSS を出力する (CSS Paged Media best practice)", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light");
		expect(html).toMatch(/widows:\s*3/);
		expect(html).toMatch(/orphans:\s*3/);
		expect(html).toMatch(/h1, h2, h3, h4, h5, h6 \{[\s\S]*?break-after: avoid/);
		expect(html).toMatch(/page-break-after: avoid/);
	});

	it("常に .pdf-section-keep の break-inside: avoid-page を出力する", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light");
		expect(html).toMatch(/\.pdf-section-keep \{[\s\S]*?break-inside: avoid-page/);
		expect(html).toMatch(/\.pdf-section-keep \{[\s\S]*?page-break-inside: avoid/);
	});

	it("もはや [data-no-break] CSS は出力しない（CSS-only への移行で廃止）", () => {
		const html = buildHtmlDocument("<h2>A</h2><p>text</p><h2>B</h2>", "test", "light", {
			level: "h2",
			smart: true,
		});
		expect(html).not.toContain("[data-no-break]");
		expect(html).not.toContain("data-no-break>");
	});

	it("adds task-list-item class to li elements with checkboxes", () => {
		const body = '<ul><li><input disabled="" type="checkbox"> task</li></ul>';
		const html = buildHtmlDocument(body, "test", "light");
		expect(html).toContain('class="task-list-item"');
		expect(html).toContain(".task-list-item { list-style: none; }");
	});
});

describe("exportAsPdf zoom", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("adds zoom and compensated max-width when zoom is not 100", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md", { zoom: 80 });
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain('<body style="zoom: 0.8; max-width: 1000px">');
	});

	it("does not add zoom style when zoom is 100", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("<body>");
		expect(html).not.toContain("zoom:");
	});

	it("compensates max-width for 50% zoom", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md", { zoom: 50 });
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain('<body style="zoom: 0.5; max-width: 1600px">');
	});

	it("compensates max-width for 150% zoom", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md", { zoom: 150 });
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain('<body style="zoom: 1.5; max-width: 533px">');
	});
});

describe("exportAsPdf — CSS-only & section wrapping (#93)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("exportPdf は (html, savePath) の 2 引数で呼ばれる（IPC pageBreak param は廃止）", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello\n## World", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: true,
		});
		expect(mockedExportPdf).toHaveBeenCalledTimes(1);
		const call = mockedExportPdf.mock.calls[0];
		expect(call.length).toBe(2);
		expect(call[1]).toBe("/output/test.pdf");
	});

	it("smart=true + criterion=section: smart-level セクションを <section class=pdf-section-keep> で wrap する", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Title\n\n## A\n\nbody A\n\n## B\n\nbody B", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: true,
			pageBreakCriterion: "section",
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		// 2 つの h2 セクションそれぞれが wrap されている
		expect(html.match(/<section class="pdf-section-keep">/g)?.length).toBe(2);
	});

	it("smart=true + criterion=compact: wrap は行わない", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Title\n\n## A\n\nbody A\n\n## B\n\nbody B", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: true,
			pageBreakCriterion: "compact",
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).not.toContain('<section class="pdf-section-keep">');
	});

	it("smart=false: section wrap は行わない（criterion 無視）", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("## A\n\nbody", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: false,
			pageBreakCriterion: "section",
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).not.toContain('<section class="pdf-section-keep">');
	});

	it("level=none: section wrap は行わない", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("## A\n\nbody", "/workspace/test.md", {
			pageBreakLevel: "none",
			smartPageBreak: true,
			pageBreakCriterion: "section",
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).not.toContain('<section class="pdf-section-keep">');
	});

	it("does NOT inject inline <script> into HTML (JS DOM 測定は完全廃止)", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello\n## World", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: true,
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).not.toContain("<script>");
	});

	it("applies zoom to the first <body> tag", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Test\n\nparagraph", "/workspace/test.md", {
			zoom: 80,
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toMatch(/<body style="zoom: 0\.8; max-width: 1000px">/);
		const bodyOpenCount = html.split("<body").length - 1;
		expect(bodyOpenCount).toBe(1);
	});
});

describe("wrapSectionsInHtml (#93)", () => {
	it("smartLevel=2 で h2 ごとのセクションを wrap する", () => {
		const body = "<h1>T</h1><p>meta</p><h2>A</h2><p>a</p><h2>B</h2><p>b</p>";
		const out = wrapSectionsInHtml(body, 2);
		expect(out).toBe(
			'<h1>T</h1><p>meta</p><section class="pdf-section-keep"><h2>A</h2><p>a</p></section><section class="pdf-section-keep"><h2>B</h2><p>b</p></section>',
		);
	});

	it("smartLevel=2 でセクション内の h3 はセクション終端にならない", () => {
		const body = "<h2>A</h2><h3>sub</h3><p>x</p><h2>B</h2>";
		const out = wrapSectionsInHtml(body, 2);
		expect(out).toBe(
			'<section class="pdf-section-keep"><h2>A</h2><h3>sub</h3><p>x</p></section><section class="pdf-section-keep"><h2>B</h2></section>',
		);
	});

	it("smartLevel=3 で h3 のセクションを wrap、h2 はセクション終端", () => {
		const body = "<h2>X</h2><h3>a</h3><p>1</p><h3>b</h3><p>2</p><h2>Y</h2>";
		const out = wrapSectionsInHtml(body, 3);
		expect(out).toContain('<section class="pdf-section-keep"><h3>a</h3><p>1</p></section>');
		expect(out).toContain('<section class="pdf-section-keep"><h3>b</h3><p>2</p></section>');
		// h2 自身は wrap されない
		expect(out).toMatch(/<h2>X<\/h2>/);
	});

	it("対象見出しが無い場合は body をそのまま返す", () => {
		const body = "<h1>T</h1><p>meta only</p>";
		const out = wrapSectionsInHtml(body, 2);
		expect(out).toBe(body);
	});

	it("空文字を渡しても crash しない", () => {
		expect(wrapSectionsInHtml("", 2)).toBe("");
	});

	it("属性付き見出しタグ（<h2 id=...>）にも対応", () => {
		const body = '<h2 id="sec">A</h2><p>a</p>';
		const out = wrapSectionsInHtml(body, 2);
		expect(out).toBe('<section class="pdf-section-keep"><h2 id="sec">A</h2><p>a</p></section>');
	});
});

describe("preprocessPageBreakMarkers (#93)", () => {
	it("`<!-- pagebreak -->` を hr.pdf-pagebreak に変換する", () => {
		const out = preprocessPageBreakMarkers("a\n\n<!-- pagebreak -->\n\nb");
		expect(out).toContain('<hr class="pdf-pagebreak"/>');
		expect(out).not.toContain("<!-- pagebreak -->");
	});

	it("空白許容と大文字小文字を区別しない", () => {
		const out = preprocessPageBreakMarkers("x<!--  PAGEBREAK  -->y");
		expect(out).toContain('<hr class="pdf-pagebreak"/>');
	});

	it("複数マーカーをすべて変換する", () => {
		const out = preprocessPageBreakMarkers("a<!-- pagebreak -->b<!-- pagebreak -->c");
		expect(out.match(/pdf-pagebreak/g)?.length).toBe(2);
	});

	it("無関係なコメントは保持する", () => {
		const out = preprocessPageBreakMarkers("<!-- TODO: clean -->");
		expect(out).toBe("<!-- TODO: clean -->");
	});

	it("マーカーが無ければそのまま返す", () => {
		const md = "# Title\n\ntext";
		expect(preprocessPageBreakMarkers(md)).toBe(md);
	});
});

describe("PDF 出力で pagebreak marker が HTML に伝わる (#93)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("`<!-- pagebreak -->` が hr.pdf-pagebreak として HTML 内に現れる", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("a\n\n<!-- pagebreak -->\n\nb", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain('class="pdf-pagebreak"');
	});

	it("hr.pdf-pagebreak の break-before:page CSS が @media print 内に出力される", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# x", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toMatch(/hr\.pdf-pagebreak\s*{\s*break-before:\s*page;/);
	});
});

describe("getDefaultPromptTemplate", () => {
	it("contains {title} and {content} placeholders", () => {
		const template = getDefaultPromptTemplate();
		expect(template).toContain("{title}");
		expect(template).toContain("{content}");
	});

	it("contains the HTML conversion prompt header", () => {
		const template = getDefaultPromptTemplate();
		expect(template).toContain("# HTML変換プロンプト");
	});
});

describe("buildPromptFromTemplate", () => {
	it("replaces {title} and {content} placeholders", () => {
		const template = "Title: {title}\n\n{content}";
		const result = buildPromptFromTemplate(template, "My Doc", "hello world");
		expect(result).toContain("Title: My Doc");
		expect(result).toContain("```markdown\nhello world\n```");
	});

	it("wraps content in a fence block", () => {
		const template = "{content}";
		const result = buildPromptFromTemplate(template, "test", "some text");
		expect(result).toMatch(/^```markdown\nsome text\n```$/);
	});

	it("uses longer fence when content contains backticks", () => {
		const template = "{content}";
		const result = buildPromptFromTemplate(template, "test", "```js\ncode\n```");
		expect(result).toContain("````markdown");
	});

	it("replaces multiple {title} occurrences", () => {
		const template = "{title} - {title}";
		const result = buildPromptFromTemplate(template, "Doc", "text");
		expect(result).toContain("Doc - Doc");
	});

	it("preserves $ and $1 in content without special expansion", () => {
		const template = "{content}";
		const result = buildPromptFromTemplate(template, "test", "Price is $100 and $1");
		expect(result).toContain("Price is $100 and $1");
	});

	it("preserves $& and $$ in title without special expansion", () => {
		const template = "Title: {title}";
		const result = buildPromptFromTemplate(template, "Cost $$ and $&", "text");
		expect(result).toContain("Cost $$ and $&");
	});
});

describe("exportAsPrompt with custom template", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses custom template when provided", async () => {
		mockedSave.mockResolvedValue("/output/test-prompt.md");
		const customTemplate = "Custom: {title}\n\n{content}";
		await exportAsPrompt("# Hello", "/workspace/test.md", customTemplate);
		const output = mockedWriteFile.mock.calls[0][1] as string;
		expect(output).toContain("Custom: test");
		expect(output).toContain("# Hello");
	});

	it("uses default template when customTemplate is null", async () => {
		mockedSave.mockResolvedValue("/output/test-prompt.md");
		await exportAsPrompt("# Hello", "/workspace/test.md", null);
		const output = mockedWriteFile.mock.calls[0][1] as string;
		expect(output).toContain("# HTML変換プロンプト");
	});

	it("uses default template when customTemplate is undefined", async () => {
		mockedSave.mockResolvedValue("/output/test-prompt.md");
		await exportAsPrompt("# Hello", "/workspace/test.md");
		const output = mockedWriteFile.mock.calls[0][1] as string;
		expect(output).toContain("# HTML変換プロンプト");
	});
});

describe("extractSvgNaturalSizeAttrs (#106 PDF img sizing)", () => {
	it("SVG ルートの width / height 属性を抽出する", () => {
		const svg = '<svg width="320" height="240" viewBox="0 0 320 240"><rect/></svg>';
		expect(extractSvgNaturalSizeAttrs(svg)).toBe(' width="320" height="240"');
	});

	it("小数点付きの寸法も対応", () => {
		const svg = '<svg width="200.5" height="100.75" viewBox="0 0 200 100"></svg>';
		expect(extractSvgNaturalSizeAttrs(svg)).toBe(' width="200.5" height="100.75"');
	});

	it("width / height が無い SVG は空文字を返す", () => {
		const svg = '<svg viewBox="0 0 100 50"></svg>';
		expect(extractSvgNaturalSizeAttrs(svg)).toBe("");
	});

	it("width が `100%` 等の非数値の場合は空文字を返す（intrinsic でないため img 用には使えない）", () => {
		const svg = '<svg width="100%" height="100%" viewBox="0 0 100 50"></svg>';
		expect(extractSvgNaturalSizeAttrs(svg)).toBe("");
	});

	it("SVG タグが無い文字列は空文字を返す", () => {
		expect(extractSvgNaturalSizeAttrs("<div>not svg</div>")).toBe("");
	});
});

describe("findMermaidCodeBlocks", () => {
	it("標準的な mermaid ブロックを検出する", () => {
		const md = "text\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nmore";
		const blocks = findMermaidCodeBlocks(md);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].source).toBe("graph TD\n  A-->B");
	});

	it("4文字以上のバッククォートに対応する", () => {
		const md = "````mermaid\ngraph TD\n  A-->B\n````";
		const blocks = findMermaidCodeBlocks(md);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].source).toBe("graph TD\n  A-->B");
	});

	it("閉じフェンスが開始より短い場合はマッチしない", () => {
		const md = "````mermaid\ngraph TD\n```\nmore\n````";
		const blocks = findMermaidCodeBlocks(md);
		expect(blocks).toHaveLength(1);
		// ``` は閉じフェンスとして無視され、```` で閉じる
		expect(blocks[0].source).toBe("graph TD\n```\nmore");
	});

	it("空のブロックはスキップする", () => {
		const md = "```mermaid\n\n```";
		const blocks = findMermaidCodeBlocks(md);
		expect(blocks).toHaveLength(0);
	});

	it("通常のコードブロックは無視する", () => {
		const md = "```js\nconst x = 1;\n```";
		const blocks = findMermaidCodeBlocks(md);
		expect(blocks).toHaveLength(0);
	});

	it("複数の mermaid ブロックを検出する", () => {
		const md =
			"```mermaid\ngraph TD\n  A-->B\n```\n\n```mermaid\nsequenceDiagram\n  A->>B: Hi\n```";
		const blocks = findMermaidCodeBlocks(md);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].source).toBe("graph TD\n  A-->B");
		expect(blocks[1].source).toBe("sequenceDiagram\n  A->>B: Hi");
	});

	it("インデントされたフェンスに対応する", () => {
		const md = "  ```mermaid\n  graph TD\n    A-->B\n  ```";
		const blocks = findMermaidCodeBlocks(md);
		expect(blocks).toHaveLength(1);
	});

	it("CRLF 改行に対応する", () => {
		const md = "```mermaid\r\ngraph TD\r\n  A-->B\r\n```";
		const blocks = findMermaidCodeBlocks(md);
		expect(blocks).toHaveLength(1);
		// offset/length で元文字列を正確にスライスできることを検証
		const sliced = md.slice(blocks[0].index, blocks[0].index + blocks[0].length);
		expect(sliced).toBe(md);
	});

	it("CRLF 混在のオフセットが正確である", () => {
		const md = "text\r\n\r\n```mermaid\r\ngraph TD\r\n```\r\nmore";
		const blocks = findMermaidCodeBlocks(md);
		expect(blocks).toHaveLength(1);
		const sliced = md.slice(blocks[0].index, blocks[0].index + blocks[0].length);
		expect(sliced).toBe("```mermaid\r\ngraph TD\r\n```");
	});
});

describe("preprocessMermaidBlocks", () => {
	it("mermaid ブロックを SVG に変換する", async () => {
		const md = "text\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nmore";
		const result = await preprocessMermaidBlocks(md, "light");
		expect(result).toContain('<div class="mermaid-diagram">');
		expect(result).toContain("<svg>");
		expect(result).not.toContain("```mermaid");
		expect(result).toContain("text\n\n");
		expect(result).toContain("\n\nmore");
	});

	it("mermaid ブロックがなければそのまま返す", async () => {
		const md = "# Hello\n\nWorld";
		const result = await preprocessMermaidBlocks(md, "light");
		expect(result).toBe(md);
	});

	it("複数の mermaid ブロックをすべて変換する", async () => {
		const md = "```mermaid\ngraph TD\n```\n\n```mermaid\nsequenceDiagram\n```";
		const result = await preprocessMermaidBlocks(md, "light");
		expect(result).not.toContain("```mermaid");
		const svgCount = (result.match(/<svg>/g) || []).length;
		expect(svgCount).toBe(2);
	});

	it("エラー時は元のコードブロックを残す", async () => {
		const { renderMermaid } = await import("./mermaid");
		(renderMermaid as Mock).mockRejectedValueOnce(new Error("Parse error"));
		const md = "```mermaid\nINVALID\n```";
		const result = await preprocessMermaidBlocks(md, "light");
		expect(result).toBe(md);
	});

	it("CRLF 改行でも正しく変換する", async () => {
		const md = "text\r\n\r\n```mermaid\r\ngraph TD\r\n```\r\n\r\nmore";
		const result = await preprocessMermaidBlocks(md, "light");
		expect(result).toContain('<div class="mermaid-diagram">');
		expect(result).not.toContain("```mermaid");
		expect(result).toContain("text\r\n\r\n");
		expect(result).toContain("\r\n\r\nmore");
	});
});
