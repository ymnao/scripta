import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./markdown-to-html";

describe("markdownToHtml", () => {
	it("converts headings and paragraphs", () => {
		const html = markdownToHtml("# Hello\n\nWorld");
		expect(html).toContain("<h1>Hello</h1>");
		expect(html).toContain("<p>World</p>");
	});

	it("converts GFM tables", () => {
		const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
		const html = markdownToHtml(md);
		expect(html).toContain("<table>");
		expect(html).toContain("<th>A</th>");
		expect(html).toContain("<td>1</td>");
	});

	it("converts GFM strikethrough", () => {
		const html = markdownToHtml("~~deleted~~");
		expect(html).toContain("<del>deleted</del>");
	});

	it("renders inline math with KaTeX", () => {
		const html = markdownToHtml("Euler's formula: $e^{i\\pi} + 1 = 0$");
		expect(html).toContain("katex");
		expect(html).not.toContain("$e^{i\\pi}");
	});

	it("renders display math with KaTeX", () => {
		const html = markdownToHtml("$$\nx^2 + y^2 = z^2\n$$");
		expect(html).toContain("katex");
		expect(html).toContain("katex-display");
	});

	it("does not process $ inside inline code", () => {
		const html = markdownToHtml("Use `$variable` in shell");
		expect(html).toContain("<code>");
		expect(html).not.toContain("katex");
	});

	it("does not process $ inside fenced code blocks", () => {
		const md = "```\n$x^2$\n```";
		const html = markdownToHtml(md);
		expect(html).toContain("<code>");
		expect(html).not.toContain("katex");
	});

	it("handles escaped $ signs", () => {
		const html = markdownToHtml("Price is \\$5");
		expect(html).not.toContain("katex");
	});

	it("handles empty string", () => {
		const html = markdownToHtml("");
		expect(html).toBe("");
	});

	it("converts bold and italic", () => {
		const html = markdownToHtml("**bold** and *italic*");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<em>italic</em>");
	});

	it("converts lists", () => {
		const md = "- item1\n- item2";
		const html = markdownToHtml(md);
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>item1</li>");
	});
});
