import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("./commands", async () => {
	const { buildScriptaAssetUrl } = await import("../../electron/preload/scripta-asset-url");
	return {
		writeFile: vi.fn().mockResolvedValue(undefined),
		exportPdf: vi.fn().mockResolvedValue(undefined),
		showSaveDialog: vi.fn(),
		// resolveHtmlImageSrcs 経由の resolveImageSrc が呼ぶ。既存 image-src.test.ts と
		// 同一の production 実装で mock (mock ドリフト防止)。
		buildAssetUrl: (path: string) => buildScriptaAssetUrl(path),
		// exportAsHtml が呼ぶ #314 data URI 埋め込み経路。default は「常に失敗」で
		// 元の src を残し、必要なテストだけ mockImplementation で成功挙動を上書きする。
		readFileBase64: vi.fn().mockRejectedValue(new Error("mock: not stubbed")),
	};
});

vi.mock("./mermaid", () => ({
	renderMermaid: vi.fn(async (source: string) => `<svg>${source}</svg>`),
}));

vi.mock("./svg-rasterize", () => ({
	svgToPng: vi.fn(async () => "data:image/png;base64,MOCK"),
}));

const { writeFile, exportPdf, showSaveDialog, readFileBase64 } = await import("./commands");
const {
	buildHtmlDocument,
	buildPromptFromTemplate,
	exportAsHtml,
	exportAsPdf,
	exportAsPrompt,
	exportSlidesAsPdf,
	extractSvgNaturalSizeAttrs,
	findMermaidCodeBlocks,
	getDefaultPromptTemplate,
	preprocessMermaidBlocks,
	preprocessPageBreakMarkers,
	resolveSmartLevel,
} = await import("./export");

const mockedSave = showSaveDialog as Mock;
const mockedWriteFile = writeFile as Mock;
const mockedExportPdf = exportPdf as Mock;
const mockedReadFileBase64 = readFileBase64 as Mock;

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

	it("includes inline KaTeX CSS in HTML (#121)", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		await exportAsHtml("$x^2$", "/workspace/test.md");
		const html = mockedWriteFile.mock.calls[0][1] as string;
		expect(html).toContain(".katex{");
		expect(html).toContain("data:font/woff2;base64,");
		expect(html).not.toContain("cdn.jsdelivr.net");
		expect(html).not.toMatch(/url\(fonts\//);
		expect(html).not.toMatch(/<link[^>]+href="https?:\/\//);
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

	it("embeds local relative images as data URI (#314)", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		mockedReadFileBase64.mockImplementation(async (path: string) => {
			expect(path).toBe("/workspace/img/hero.png");
			return "AAAA";
		});
		await exportAsHtml("![alt](./img/hero.png)", "/workspace/test.md");
		const html = mockedWriteFile.mock.calls[0][1] as string;
		expect(html).toContain('src="data:image/png;base64,AAAA"');
		expect(html).not.toContain('src="./img/hero.png"');
		// 外部ブラウザで解決できない scripta-asset:// も混入しないこと
		expect(html).not.toContain("scripta-asset://");
	});

	it("leaves http(s) src untouched (no fetch attempt)", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		await exportAsHtml("![](https://example.com/x.png)", "/workspace/test.md");
		const html = mockedWriteFile.mock.calls[0][1] as string;
		expect(html).toContain('src="https://example.com/x.png"');
		expect(mockedReadFileBase64).not.toHaveBeenCalled();
	});

	it("keeps original src when readFileBase64 fails (broken image, but export succeeds)", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		mockedReadFileBase64.mockRejectedValue(new Error("EACCES"));
		const result = await exportAsHtml("![](./missing.png)", "/workspace/test.md");
		expect(result).toBe(true);
		const html = mockedWriteFile.mock.calls[0][1] as string;
		// data: に置換されず元 src が残る (browser は broken image を表示するが export は完遂)
		expect(html).toContain('src="./missing.png"');
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

	it("resolves relative image paths against filePath into scripta-asset URLs (PDF)", async () => {
		// PDF は Electron 内部で printToPDF に渡すため scripta-asset:// をそのまま
		// 使える (pdf.ts 側で pdfSession に protocol handler 登録済み)。activeTabPath
		// 基準で workspace 内相対パスが解決されることを回帰として固定。
		mockedSave.mockResolvedValue("/output/deck.pdf");
		await exportAsPdf("![alt](./img/pic.png)", "/workspace/notes/deck.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("scripta-asset://localhost/workspace/notes/img/pic.png");
		expect(html).not.toMatch(/<img[^>]+src="\.\/img\/pic\.png"/);
	});

	it("converts single newlines to <br> in PDF HTML", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("line1\nline2", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("<br");
	});

	it("renders KaTeX math in PDF HTML (#121)", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("$x^2$", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain(".katex{");
		expect(html).toContain("data:font/woff2;base64,");
		expect(html).not.toContain("cdn.jsdelivr.net");
		expect(html).not.toMatch(/url\(fonts\//);
		expect(html).not.toMatch(/<link[^>]+href="https?:\/\//);
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
		// 4 番目の signal は export 経路では未指定 (undefined)。
		expect(renderMermaid).toHaveBeenCalledWith(
			expect.any(String),
			"light",
			{
				htmlLabels: false,
				useMaxWidth: false,
			},
			undefined,
		);
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
		expect(renderMermaid).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(String),
			{},
			undefined,
		);
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

describe("buildHtmlDocument page break CSS (#93)", () => {
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

describe("exportAsPdf — meta tag + page break CSS (#93)", () => {
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

	it("renderer は section wrap しない (#93: main 側 script が break-before 注入)", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Title\n\n## A\n\nbody A\n\n## B\n\nbody B", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: true,
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		// wrapper を一切作らない（wrapper の break-inside hint が Chromium で overcaution を
		// 起こす quirk を避けるため、見出し element に直接 inline break-before を注入する方式）
		expect(html).not.toContain('<section class="pdf-section-keep">');
		expect(html).not.toContain('<table class="pdf-section-keep">');
	});

	it("smart + level + criterion を meta tag 経由で main 側 script へ伝える", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		// h2 が複数あるドキュメントで requested=h2 がそのまま採用される
		await exportAsPdf("# T\n\n## A\n\nbody\n\n## B\n\nbody", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: true,
			pageBreakCriterion: "compact",
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain('<meta name="scripta-pdf-smart-level" content="2">');
		expect(html).toContain('<meta name="scripta-pdf-criterion" content="compact">');
		// force-level は script 側で smart-level - 1 として導出するので meta tag は emit しない
		expect(html).not.toContain("scripta-pdf-force-level");
	});

	it("requested level に該当見出しが足りない場合は近いレベルへ自動補正 (h3 fallback)", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		// h1 1 個 + h3 3 個。requested=h2 だが doc に h2 が無いので h3 に補正される
		await exportAsPdf(
			"# T\n\n### A\n\nbody\n\n### B\n\nbody\n\n### C\n\nbody",
			"/workspace/test.md",
			{ pageBreakLevel: "h2", smartPageBreak: true },
		);
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain('<meta name="scripta-pdf-smart-level" content="3">');
	});

	it("smart=false のときは meta tag を埋め込まない (script の no-op signal)", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("## A\n\nbody", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: false,
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).not.toContain("scripta-pdf-smart-level");
		expect(html).not.toContain("scripta-pdf-criterion");
	});

	it("level=none のときは meta tag を埋め込まない (script の no-op signal)", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("## A\n\nbody", "/workspace/test.md", {
			pageBreakLevel: "none",
			smartPageBreak: true,
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).not.toContain("scripta-pdf-smart-level");
	});

	it("requested level の対象見出しが不足し fallback 候補も無ければ meta を出さない", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		// h2 / h3 が無く、見出しも H1 1 個のみ (= 2 件未満) で auto-detect も failure
		await exportAsPdf("# Single\n\nbody", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: true,
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).not.toContain("scripta-pdf-smart-level");
	});

	it("renderer は HTML に inline <script> を埋め込まない (DOM 測定は main 側 executeJavaScript)", async () => {
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

describe("resolveSmartLevel (#93)", () => {
	const make = (...tags: string[]) => tags.join("\n");

	it("requested level に複数見出しがあればそのまま採用", () => {
		const body = make("<h1>T</h1>", "<h2>A</h2>", "<h2>B</h2>");
		expect(resolveSmartLevel(body, 2)).toBe(2);
	});

	it("requested level に該当が無ければ最も浅いレベル (h2 > h3 > h1 > h4) で auto-detect", () => {
		// h2=0, h3=3 → h3 fallback (deeper 方向)
		const body = make("<h1>T</h1>", "<h3>a</h3>", "<h3>b</h3>", "<h3>c</h3>");
		expect(resolveSmartLevel(body, 2)).toBe(3);
	});

	it("h2 と h3 の両方があれば h2 優先", () => {
		const body = make("<h2>A</h2>", "<h2>B</h2>", "<h3>x</h3>", "<h3>y</h3>");
		expect(resolveSmartLevel(body, 3)).toBe(3); // requested 優先
		expect(resolveSmartLevel(body, 1)).toBe(2); // requested の対象無し → h2 fallback
	});

	it("対象見出しが 2 件未満なら null", () => {
		const body = make("<h1>Only</h1>", "<p>p</p>");
		expect(resolveSmartLevel(body, 2)).toBeNull();
	});

	it("h1 が複数あれば fallback で採用 (h2/h3 が無い場合)", () => {
		const body = make("<h1>A</h1>", "<h1>B</h1>");
		expect(resolveSmartLevel(body, 2)).toBe(1);
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

	it("fenced code block 内のリテラル <!-- pagebreak --> は変換しない", () => {
		const md = "text\n\n```html\n<!-- pagebreak -->\n```\n\nafter\n\n<!-- pagebreak -->\n\nend";
		const out = preprocessPageBreakMarkers(md);
		// code block 内のものはそのまま、外側のものだけ hr に
		expect(out).toContain("```html\n<!-- pagebreak -->\n```");
		expect(out.match(/pdf-pagebreak/g)?.length).toBe(1);
	});

	it("inline code 内のリテラル <!-- pagebreak --> も変換しない", () => {
		const md = "text `<!-- pagebreak -->` more\n\n<!-- pagebreak -->\n\nend";
		const out = preprocessPageBreakMarkers(md);
		expect(out).toContain("`<!-- pagebreak -->`");
		expect(out.match(/pdf-pagebreak/g)?.length).toBe(1);
	});

	it("indented code block (4 space) 内のリテラル <!-- pagebreak --> も変換しない", () => {
		const md =
			"before\n\n    <!-- pagebreak -->\n    next line\n\nafter\n\n<!-- pagebreak -->\n\nend";
		const out = preprocessPageBreakMarkers(md);
		// indented code 内のものはそのまま、外側のものだけ hr に
		expect(out).toContain("    <!-- pagebreak -->");
		expect(out.match(/pdf-pagebreak/g)?.length).toBe(1);
	});

	it("raw <pre>/<code> 内のリテラル <!-- pagebreak --> も変換しない", () => {
		const md = "before\n\n<pre><!-- pagebreak --></pre>\n\nafter\n\n<!-- pagebreak -->\n\nend";
		const out = preprocessPageBreakMarkers(md);
		expect(out).toContain("<pre><!-- pagebreak --></pre>");
		expect(out.match(/pdf-pagebreak/g)?.length).toBe(1);
	});

	it("CommonMark: 閉じフェンスが開きより長い fenced code 内も skip する", () => {
		// 開き 4 backticks, 閉じ 5 backticks (CommonMark spec で valid)
		const md = "````\n<!-- pagebreak -->\n`````\n\nafter\n\n<!-- pagebreak -->\n\nend";
		const out = preprocessPageBreakMarkers(md);
		// code block 内のものは温存
		expect(out).toContain("````\n<!-- pagebreak -->");
		// outside の 1 件だけ変換
		expect(out.match(/pdf-pagebreak/g)?.length).toBe(1);
	});

	it("CommonMark: ~~~ fence でも閉じが長い場合に skip する", () => {
		const md = "~~~\n<!-- pagebreak -->\n~~~~~\n\nafter\n\n<!-- pagebreak -->\n\nend";
		const out = preprocessPageBreakMarkers(md);
		expect(out).toContain("~~~\n<!-- pagebreak -->");
		expect(out.match(/pdf-pagebreak/g)?.length).toBe(1);
	});

	it("CRLF 行末でも fenced code block 内の marker を skip する", () => {
		// CRLF (\r\n) で記述された markdown。`text.split('\n')` だと各行末に \r が残る
		// ので、close fence regex が \r を許容しないと「未閉じ fenced」と誤判定する。
		const md =
			"before\r\n\r\n```\r\n<!-- pagebreak -->\r\n```\r\n\r\nafter\r\n\r\n<!-- pagebreak -->\r\n\r\nend";
		const out = preprocessPageBreakMarkers(md);
		// code block 内のものは温存
		expect(out).toContain("```\r\n<!-- pagebreak -->\r\n```");
		// 外側の 1 件だけ変換
		expect(out.match(/pdf-pagebreak/g)?.length).toBe(1);
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

describe("exportSlidesAsPdf", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("save ダイアログでキャンセルされたら false を返し exportPdf を呼ばない", async () => {
		mockedSave.mockResolvedValue(null);
		const result = await exportSlidesAsPdf("# A\n---\n# B", "/workspace/deck.md");
		expect(result).toBe(false);
		expect(mockedExportPdf).not.toHaveBeenCalled();
	});

	it("スライドを --- で分割して 1 section = 1 スライドの HTML を生成する", async () => {
		mockedSave.mockResolvedValue("/output/deck-slides.pdf");
		await exportSlidesAsPdf("# Slide 1\n---\n# Slide 2\n---\n# Slide 3", "/workspace/deck.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		const sectionMatches = html.match(/<section class="slide/g);
		expect(sectionMatches?.length).toBe(3);
		expect(html).toContain("Slide 1");
		expect(html).toContain("Slide 2");
		expect(html).toContain("Slide 3");
	});

	it("論理サイズ 1280×720 のページサイズ + マージン 0 で printToPDF を呼ぶ", async () => {
		mockedSave.mockResolvedValue("/output/deck-slides.pdf");
		await exportSlidesAsPdf("# only", "/workspace/deck.md");
		const options = mockedExportPdf.mock.calls[0][2];
		expect(options.pageSize.width).toBe(Math.round(1280 * (25400 / 96)));
		expect(options.pageSize.height).toBe(Math.round(720 * (25400 / 96)));
		expect(options.marginsInches).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
		expect(options.skipSectionBreakScript).toBe(true);
	});

	it("最終スライドの余分な空白ページを避けるため :not(:last-child) で break-after を絞る", async () => {
		mockedSave.mockResolvedValue("/output/deck-slides.pdf");
		await exportSlidesAsPdf("# A\n---\n# B", "/workspace/deck.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain(".slide:not(:last-child)");
		expect(html).toContain("break-after: page");
	});

	it("default 保存名は <basename>-slides.pdf", async () => {
		mockedSave.mockResolvedValue("/output/deck-slides.pdf");
		await exportSlidesAsPdf("# A", "/workspace/deck.md");
		expect(mockedSave).toHaveBeenCalledWith(
			expect.objectContaining({ defaultPath: "deck-slides.pdf" }),
		);
	});

	it("mermaid ブロックを PNG (data:image/png;base64,...) として埋め込む (rasterize option)", async () => {
		mockedSave.mockResolvedValue("/output/deck-slides.pdf");
		await exportSlidesAsPdf("# Slide\n\n```mermaid\ngraph TD\n  A-->B\n```", "/workspace/deck.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain('src="data:image/png;base64,MOCK"');
		expect(html).toContain("mermaid-diagram");
	});

	it("filePath 基準で相対画像パスを scripta-asset URL に解決する", async () => {
		mockedSave.mockResolvedValue("/output/deck-slides.pdf");
		await exportSlidesAsPdf("# Slide\n\n![](./img/hero.png)", "/workspace/notes/deck.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("scripta-asset://localhost/workspace/notes/img/hero.png");
	});

	it("空スライド (末尾 --- 分割による空 section) も 1 ページとして保持する", async () => {
		mockedSave.mockResolvedValue("/output/deck-slides.pdf");
		await exportSlidesAsPdf("# A\n---\n\n---\n# C", "/workspace/deck.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		const sectionMatches = html.match(/<section class="slide/g);
		expect(sectionMatches?.length).toBe(3);
	});

	it("frontmatter theme が無ければ light 背景で出力 (Fable #12 default)", async () => {
		mockedSave.mockResolvedValue("/output/deck-slides.pdf");
		await exportSlidesAsPdf("# A\n---\n# B", "/workspace/deck.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("color-scheme: light");
		expect(html).toContain("background: #ffffff");
	});

	it("frontmatter theme: dark で背景・前景を dark に切り替える (Fable #12)", async () => {
		mockedSave.mockResolvedValue("/output/deck-slides.pdf");
		await exportSlidesAsPdf("---\ntheme: dark\n---\n\n# A\n---\n# B", "/workspace/deck.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("color-scheme: dark");
		expect(html).toContain("background: #1a1a1a");
		expect(html).toContain("color: #d4d4d4");
		// link 色 (F3): preview `--color-text-link` (dark: #60a5fa) と揃える
		expect(html).toContain("a { color: #60a5fa;");
	});

	it("frontmatter theme: light を明示指定しても light のまま", async () => {
		mockedSave.mockResolvedValue("/output/deck-slides.pdf");
		await exportSlidesAsPdf("---\ntheme: light\n---\n\n# A", "/workspace/deck.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("color-scheme: light");
		expect(html).toContain("background: #ffffff");
		expect(html).toContain("a { color: #2563eb;");
	});

	it("frontmatter を slide 1 本文から除外して PDF に出力する (F1)", async () => {
		mockedSave.mockResolvedValue("/output/deck-slides.pdf");
		await exportSlidesAsPdf(
			"---\ntheme: dark\ntitle: T\n---\n\n# First\n---\n# Second",
			"/workspace/deck.md",
		);
		const html = mockedExportPdf.mock.calls[0][0] as string;
		// frontmatter 本文 (theme: dark / title: T) が section 内に含まれないこと
		expect(html).not.toContain("theme: dark");
		expect(html).not.toContain("title: T");
		expect(html).toContain("First");
		expect(html).toContain("Second");
	});
});
