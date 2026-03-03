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

	it("renders empty task list item as checkbox", () => {
		const html = markdownToHtml("- [ ]");
		expect(html).toContain('type="checkbox"');
		expect(html).not.toContain("[ ]");
	});

	it("renders empty checked task list item as checkbox", () => {
		const html = markdownToHtml("- [x]");
		expect(html).toContain('type="checkbox"');
		expect(html).toContain("checked");
	});

	it("does not process $ inside inline code after display math replacement shifts offsets", () => {
		// Regression: display math replacement changes string length, so
		// code-range offsets collected from the original string become invalid
		// for the inline math pass.
		const md = "$$a^2$$\n\nSome text with `$var` in code";
		const html = markdownToHtml(md);
		expect(html).toContain("katex-display"); // display math rendered
		expect(html).toContain("<code>$var</code>"); // inline code preserved
		expect(html).not.toMatch(/<code>.*katex.*<\/code>/); // no katex inside code
	});

	it("handles display math followed by inline math correctly", () => {
		const md = "$$x^2$$\n\nThen $y^2$ inline";
		const html = markdownToHtml(md);
		expect(html).toContain("katex-display");
		// inline math should also be rendered
		expect(html.match(/katex/g)?.length).toBeGreaterThanOrEqual(2);
	});

	it("does not pair inline $ with display $$ across lines", () => {
		const md = "Inline $x^2$ text\n\n$$\ny^2\n$$";
		const html = markdownToHtml(md);
		// inline math should be rendered
		expect(html).toContain("katex");
		// display math should also be rendered
		expect(html).toContain("katex-display");
	});

	it("strips script tags from raw HTML in markdown", () => {
		const md = 'Hello\n\n<script>alert("xss")</script>\n\nWorld';
		const html = markdownToHtml(md);
		expect(html).not.toContain("<script");
		expect(html).toContain("Hello");
		expect(html).toContain("World");
	});

	it("strips event handlers from HTML tags", () => {
		const md = '<div onclick="alert(1)">click me</div>';
		const html = markdownToHtml(md);
		expect(html).not.toContain("onclick");
		expect(html).toContain("click me");
	});

	it("strips javascript: URIs from links", () => {
		const md = '<a href="javascript:alert(1)">link</a>';
		const html = markdownToHtml(md);
		expect(html).not.toContain("javascript:");
		expect(html).toContain("link");
	});

	it("preserves safe HTML tags", () => {
		const md = "<details><summary>Toggle</summary>\n\nHidden content\n\n</details>";
		const html = markdownToHtml(md);
		expect(html).toContain("<details>");
		expect(html).toContain("<summary>");
	});

	it("does not process $ inside link URLs", () => {
		const md = "[link]($x$)";
		const html = markdownToHtml(md);
		expect(html).toContain('href="$x$"');
		expect(html).not.toContain("katex");
	});

	it("does not process $ inside image URLs", () => {
		const md = "![alt]($img$)";
		const html = markdownToHtml(md);
		expect(html).toContain('src="$img$"');
		expect(html).not.toContain("katex");
	});

	it("does not process display math inside tilde fenced code blocks", () => {
		const md = "~~~\n$$\nx^2\n$$\n~~~";
		const html = markdownToHtml(md);
		expect(html).not.toContain("katex");
	});

	it("renders display math inside blockquote preserving structure", () => {
		const md = "> $$\n> x^2\n> $$";
		const html = markdownToHtml(md);
		expect(html).toContain("katex");
		expect(html).toContain("<blockquote>");
	});

	it("does not convert single newlines to <br> by default", () => {
		const html = markdownToHtml("line1\nline2");
		expect(html).not.toContain("<br");
	});

	it("converts single newlines to <br> when breaks option is true", () => {
		const html = markdownToHtml("line1\nline2", { breaks: true });
		expect(html).toContain("<br");
	});
});
