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
const { exportAsHtml, exportAsPdf, exportAsPrompt } = await import("./export");

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

	it("defaults to light theme for PDF", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md");
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("color-scheme: light");
		expect(html).not.toContain("prefers-color-scheme");
	});

	it("applies dark theme when specified", async () => {
		mockedSave.mockResolvedValue("/output/test.pdf");
		await exportAsPdf("# Hello", "/workspace/test.md", { theme: "dark" });
		const html = mockedExportPdf.mock.calls[0][0] as string;
		expect(html).toContain("color-scheme: dark");
		expect(html).toContain("background: #1a1a1a");
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
});
