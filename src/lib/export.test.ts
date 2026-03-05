import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({
	save: vi.fn(),
}));

vi.mock("./commands", () => ({
	writeFile: vi.fn().mockResolvedValue(undefined),
	exportPdf: vi.fn().mockResolvedValue(undefined),
}));

const { save } = await import("@tauri-apps/plugin-dialog");
const { writeFile, exportPdf } = await import("./commands");
const {
	buildDynamicPageBreakScript,
	buildHtmlDocument,
	exportAsHtml,
	exportAsPdf,
	exportAsPrompt,
} = await import("./export");

const mockedSave = save as Mock;
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

	it("uses system theme with media query by default", async () => {
		mockedSave.mockResolvedValue("/output/test.html");
		await exportAsHtml("# Hello", "/workspace/test.md");
		const html = mockedWriteFile.mock.calls[0][1] as string;
		expect(html).toContain("color-scheme: light dark");
		expect(html).toContain("prefers-color-scheme");
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

	it("includes page break CSS when pageBreakLevel is set", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: false,
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("h1, h2 { break-before: page; }");
	});
});

describe("buildHtmlDocument page break", () => {
	it("includes h1 break-before when level is h1", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light", {
			level: "h1",
			smart: false,
		});
		expect(html).toContain("h1 { break-before: page; }");
	});

	it("includes h1 and h2 break-before when level is h2", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light", {
			level: "h2",
			smart: false,
		});
		expect(html).toContain("h1, h2 { break-before: page; }");
	});

	it("includes h1, h2 and h3 break-before when level is h3", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light", {
			level: "h3",
			smart: false,
		});
		expect(html).toContain("h1, h2, h3 { break-before: page; }");
	});

	it("smart: marks first heading with data-no-break", () => {
		const html = buildHtmlDocument("<h2>First</h2><p>text</p><h2>Second</h2>", "test", "light", {
			level: "h2",
			smart: true,
		});
		expect(html).toContain("<h2 data-no-break>First</h2>");
		expect(html).toContain("<h2>Second</h2>");
		expect(html).toContain("[data-no-break] { break-before: auto !important; }");
	});

	it("smart: marks sub-heading with data-no-break even with content between", () => {
		const html = buildHtmlDocument("<h2>Section</h2><p>intro</p><h3>Sub</h3>", "test", "light", {
			level: "h3",
			smart: true,
		});
		expect(html).toContain("<h2 data-no-break>Section</h2>");
		expect(html).toContain("<h3 data-no-break>Sub</h3>");
	});

	it("smart: does not mark same-level heading with data-no-break", () => {
		const html = buildHtmlDocument("<h2>A</h2><p>text</p><h2>B</h2>", "test", "light", {
			level: "h2",
			smart: true,
		});
		expect(html).toContain("<h2 data-no-break>A</h2>");
		expect(html).toContain("<h2>B</h2>");
	});

	it("smart: does not mark shallower heading with data-no-break", () => {
		const html = buildHtmlDocument("<h2>A</h2><h3>B</h3><p>text</p><h2>C</h2>", "test", "light", {
			level: "h3",
			smart: true,
		});
		expect(html).toContain("<h2 data-no-break>A</h2>");
		expect(html).toContain("<h3 data-no-break>B</h3>");
		expect(html).toContain("<h2>C</h2>");
	});

	it("smart: ignores headings beyond target level", () => {
		const html = buildHtmlDocument(
			"<h1>Ch</h1><h2>Sec</h2><h3>Sub</h3><h2>Next</h2>",
			"test",
			"light",
			{ level: "h2", smart: true },
		);
		expect(html).toContain("<h1 data-no-break>Ch</h1>");
		expect(html).toContain("<h2 data-no-break>Sec</h2>");
		expect(html).toContain("<h3>Sub</h3>");
		expect(html).toContain("<h2>Next</h2>");
	});

	it("smart: does not suppress sub-heading when many blocks between", () => {
		const html = buildHtmlDocument(
			"<h2>Section</h2><p>intro</p><ul><li>a</li></ul><h3>Sub</h3>",
			"test",
			"light",
			{ level: "h3", smart: true },
		);
		expect(html).toContain("<h2 data-no-break>Section</h2>");
		expect(html).toContain("<h3>Sub</h3>");
	});

	it("does not include break-before when level is none", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light", {
			level: "none",
			smart: true,
		});
		expect(html).not.toContain("break-before: page");
	});

	it("does not include break-before when pageBreak is undefined", () => {
		const html = buildHtmlDocument("<p>test</p>", "test", "light");
		expect(html).not.toContain("break-before: page");
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

describe("buildDynamicPageBreakScript", () => {
	it("includes correct maxLevel for h1", () => {
		const script = buildDynamicPageBreakScript("h1");
		expect(script).toContain("var maxLevel = 1;");
	});

	it("includes correct maxLevel for h2", () => {
		const script = buildDynamicPageBreakScript("h2");
		expect(script).toContain("var maxLevel = 2;");
	});

	it("includes correct maxLevel for h3", () => {
		const script = buildDynamicPageBreakScript("h3");
		expect(script).toContain("var maxLevel = 3;");
	});
});

describe("exportAsPdf dynamic page break script", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("injects script when smart page break is enabled", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello\n## World", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: true,
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("<script>");
		expect(html).toContain("var maxLevel = 2;");
		expect(html).toContain("</script>\n</body>");
	});

	it("does not inject script when smart page break is disabled", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md", {
			pageBreakLevel: "h2",
			smartPageBreak: false,
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).not.toContain("<script>");
	});

	it("does not inject script when pageBreakLevel is none", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md", {
			pageBreakLevel: "none",
			smartPageBreak: true,
		});
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).not.toContain("<script>");
	});

	it("does not inject script when pageBreak options are not provided", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).not.toContain("<script>");
	});
});
