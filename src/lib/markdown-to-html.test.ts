import { describe, expect, it } from "vitest";
import { finalizeHtml } from "./finalize-html";
import { markdownToHtmlRaw } from "./markdown-to-html";

// テスト用 helper: 本 file は markdown → HTML → sanitize の合成挙動を assert する
// (post-processor は経由しない fast path)。production 経路は必ず
// `markdownToHtmlRaw` + post-processor + `finalizeHtml` を明示的に組み立てるため、
// この shim は test 側にのみ置く (production コードから再 import される余地を消す)。
const markdownToHtml = (md: string, opts?: { breaks?: boolean }): string =>
	finalizeHtml(markdownToHtmlRaw(md, opts), { allowAssetProtocol: true });

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

	it("renders display math where content starts on same line as $$", () => {
		const html = markdownToHtml("$$E=mc^2\n+ x$$");
		expect(html).toContain("katex");
		expect(html).toContain("katex-display");
	});

	it("renders display math where content ends on same line as $$", () => {
		const html = markdownToHtml("$$\nE=mc^2$$");
		expect(html).toContain("katex");
		expect(html).toContain("katex-display");
	});

	it("does not process $ inside inline code", () => {
		const html = markdownToHtml("Use `$variable` in shell");
		expect(html).toContain("<code>");
		expect(html).not.toContain("katex");
	});

	it("preserves backslash in \\$ inside inline code", () => {
		const html = markdownToHtml("Use `\\$HOME` in shell");
		expect(html).toContain("<code>");
		expect(html).toContain("\\$HOME");
		expect(html).not.toContain("katex");
	});

	it("does not process $ inside fenced code blocks", () => {
		const md = "```\n$x^2$\n```";
		const html = markdownToHtml(md);
		expect(html).toContain("<code>");
		expect(html).not.toContain("katex");
	});

	it("preserves backslash in \\$ inside fenced code blocks", () => {
		const md = "```\n\\$x^2\n```";
		const html = markdownToHtml(md);
		expect(html).toContain("<code>");
		expect(html).toContain("\\$");
		expect(html).not.toContain("katex");
	});

	it("preserves backslash in \\$ inside blockquote fenced code blocks", () => {
		const md = "> ```\n> \\$x\n> ```";
		const html = markdownToHtml(md);
		expect(html).toContain("<code>");
		expect(html).toContain("\\$");
		expect(html).not.toContain("katex");
	});

	it("preserves backslash in \\$ inside list fenced code blocks", () => {
		const md = "- ```\n  \\$HOME\n  ```";
		const html = markdownToHtml(md);
		expect(html).toContain("<code>");
		expect(html).toContain("\\$");
		expect(html).not.toContain("katex");
	});

	it("preserves backslash in \\$ inside indented code blocks", () => {
		const md = "    \\$HOME";
		const html = markdownToHtml(md);
		expect(html).toContain("<code>");
		expect(html).toContain("\\$HOME");
		expect(html).not.toContain("katex");
	});

	it("preserves backslash in \\$ inside blockquote indented code blocks", () => {
		const md = ">     \\$HOME";
		const html = markdownToHtml(md);
		expect(html).toContain("<code>");
		expect(html).toContain("\\$HOME");
		expect(html).not.toContain("katex");
	});

	it("does not process math inside raw HTML <code> tags", () => {
		const md = "<code>\\$HOME</code>";
		const html = markdownToHtml(md);
		expect(html).toContain("<code>");
		expect(html).not.toContain("katex");
	});

	it("preserves backslash in \\$ inside raw HTML <pre> tags", () => {
		const md = "<pre>\\$VAR</pre>";
		const html = markdownToHtml(md);
		expect(html).toContain("\\$VAR");
		expect(html).not.toContain("katex");
	});

	it("handles escaped $ signs", () => {
		const html = markdownToHtml("Price is \\$5");
		expect(html).not.toContain("katex");
	});

	it("does not process math when both $ are escaped", () => {
		const html = markdownToHtml("\\$x^2\\$");
		expect(html).not.toContain("katex");
		expect(html).toContain("$x^2$");
	});

	it("treats \\\\$ as literal backslash followed by math delimiter", () => {
		const html = markdownToHtml("\\\\$x^2$");
		expect(html).toContain("katex");
	});

	it("renders escaped $ inside inline math as literal dollar", () => {
		const html = markdownToHtml("$ 50 \\$ $");
		expect(html).toContain("katex");
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

	it("does not process display math in 4-space indented code blocks", () => {
		const md = "    $$\n    x^2\n    $$";
		const html = markdownToHtml(md);
		expect(html).toContain("<code>");
		expect(html).not.toContain("katex");
	});

	it("does not process display math inside blockquote fenced code blocks", () => {
		const md = "> ```\n> $$\n> x^2\n> $$\n> ```";
		const html = markdownToHtml(md);
		expect(html).toContain("<blockquote>");
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

	it("does not strip leading minus/plus from display math content", () => {
		const md = "$$\n-x^2 + y\n$$";
		const html = markdownToHtml(md);
		expect(html).toContain("katex");
		// The minus sign must not be stripped — verify by checking
		// that KaTeX rendered the minus (rendered as <mo>−</mo>)
		expect(html).toContain("−");
	});

	it("handles CRLF line endings in display math", () => {
		const md = "$$\r\nx^2 + y^2 = z^2\r\n$$";
		const html = markdownToHtml(md);
		expect(html).toContain("katex");
		expect(html).toContain("katex-display");
	});

	it("renders multi-line display math that starts mid-line as KaTeX (#169)", () => {
		// Pattern A: opening $$ appears after body text and spans a newline.
		const html = markdownToHtml("text $$x\n+ y$$ more");
		expect(html).toContain("katex-display");
		expect(html).not.toContain("$$");
	});

	it("renders multi-line display math with leading text and preserves it (#169)", () => {
		// Pattern B: text precedes the opening $$ on its line.
		const html = markdownToHtml("leading $$\nE=mc^2\n$$");
		expect(html).toContain("katex-display");
		expect(html).not.toContain("$$");
		expect(html).toContain("leading");
	});

	it("renders multi-line display math with trailing text and preserves it (#169)", () => {
		// Pattern C: text follows the closing $$ on its line.
		const html = markdownToHtml("$$\nE=mc^2\n$$ trailing");
		expect(html).toContain("katex-display");
		expect(html).not.toContain("$$");
		expect(html).toContain("trailing");
	});

	// 単一行 display / inline math の inline tokenizer extension 化 (#170)。
	// walkTokens 方式は math 内の escape (`\,`) / emphasis (`_`) で text トークンが
	// 分断され、`$$` 生出力・`<em>` 混入・inline `$` のペアずれを起こしていた。
	// PDF 経路は { breaks: true } なので主要ケースは breaks: true で検証する。
	it("renders single-line display math with escape and emphasis chars (#170)", () => {
		// ベイズ式: `\,` (escape) と `_` (emphasis 成立) と `|` を含む。
		const html = markdownToHtml(
			"$$p(C_k|\\mathbf{x}) = \\frac{p(\\mathbf{x}|C_k) \\, p(C_k)}{p(\\mathbf{x})}$$",
			{ breaks: true },
		);
		expect(html).toContain("katex-display");
		expect(html).not.toContain("$$");
		expect(html).not.toContain("<em>");
	});

	it("renders single-line display math with underscore subscripts (#170)", () => {
		const html = markdownToHtml("$$\\int_{\\mathcal{R}_j} L_{kj}$$", { breaks: true });
		expect(html).toContain("katex-display");
		expect(html).not.toContain("$$");
		expect(html).not.toContain("<em>");
	});

	it("does not mis-pair inline $ across Japanese text between two math spans (#170)", () => {
		const html = markdownToHtml(
			"積の規則 $p(\\mathbf{x}, C_k) = p(C_k|\\mathbf{x}) \\, p(\\mathbf{x})$ を使うと、共通因子の $p(\\mathbf{x})$ を消す",
			{ breaks: true },
		);
		expect(html).toContain("katex");
		expect(html).not.toContain("<em>");
		// 「を使うと、共通因子の」は数式の外（KaTeX annotation の外）にプレーンテキストで残る。
		const annotations = [...html.matchAll(/<annotation[^>]*>([\s\S]*?)<\/annotation>/g)].map(
			(m) => m[1],
		);
		expect(annotations.some((a) => a.includes("を使うと、共通因子の"))).toBe(false);
		expect(html).toContain("を使うと、共通因子の");
	});

	it("renders inline math inside a heading (#170)", () => {
		const html = markdownToHtml("# 式 $x_i$ の説明", { breaks: true });
		expect(html).toContain("katex");
		expect(html).toContain("<h1");
	});

	it("renders inline math inside a GFM table cell (#170)", () => {
		// walkTokens はテーブルの header/rows を再帰しないため壊れていた。
		const md = "| 変数 | 説明 |\n| --- | --- |\n| $x_i$ | 入力 |";
		const html = markdownToHtml(md, { breaks: true });
		expect(html).toContain("<table>");
		expect(html).toContain("katex");
	});

	it("does not convert single newlines to <br> by default", () => {
		const html = markdownToHtml("line1\nline2");
		expect(html).not.toContain("<br");
	});

	it("converts single newlines to <br> when breaks option is true", () => {
		const html = markdownToHtml("line1\nline2", { breaks: true });
		expect(html).toContain("<br");
	});

	// image alt 内の math は属性値文脈なので KaTeX HTML ではなくプレーン TeX を保持する (#170)。
	it("keeps inline math as plain TeX in image alt (not KaTeX HTML)", () => {
		const html = markdownToHtml("![alt $x$](img.png)", { breaks: true });
		expect(html).toContain('alt="alt $x$"');
		expect(html).not.toContain('alt="alt <span');
		// img タグの中に katex クラスが入らない
		const imgMatch = html.match(/<img[^>]*>/);
		expect(imgMatch).not.toBeNull();
		expect(imgMatch?.[0]).not.toContain("katex");
	});

	it("keeps single-line display math as plain TeX in image alt", () => {
		// alt 属性値に $$ が残るのが正しい（KaTeX HTML に展開してはならない）
		const html = markdownToHtml("![v $$x$$](i.png)", { breaks: true });
		expect(html).toContain('alt="v $$x$$"');
		const imgMatch = html.match(/<img[^>]*>/);
		expect(imgMatch).not.toBeNull();
		expect(imgMatch?.[0]).not.toContain("katex");
	});

	it("keeps inline math as plain TeX in image alt inside a GFM table cell", () => {
		// ヘッダ行 + 区切り行 + ボディ行でテーブルを構成し、<td> を含む出力を確認する
		const md = "| img |\n| --- |\n| ![alt $x$](img.png) |";
		const html = markdownToHtml(md, { breaks: true });
		// td の中に img が存在し、その alt がプレーンのまま
		expect(html).toContain("<td>");
		expect(html).toContain('alt="alt $x$"');
		const imgMatch = html.match(/<img[^>]*>/);
		expect(imgMatch).not.toBeNull();
		expect(imgMatch?.[0]).not.toContain("katex");
	});

	it("still renders KaTeX in link label (text context) after image alt fix", () => {
		// リンクテキストはテキスト文脈なので KaTeX 化が正しい（回帰確認）
		const html = markdownToHtml("[$x$](http://example.com)", { breaks: true });
		expect(html).toContain("katex");
	});

	it("renders surrounding math as KaTeX while keeping image alt plain", () => {
		// 画像の周囲の math は KaTeX 化され、alt はプレーンのまま
		const html = markdownToHtml("$y$ ![alt $x$](img.png) $z$", { breaks: true });
		// 周囲の $y$ と $z$ が KaTeX 化されて 2 回以上 katex が現れる
		const katexCount = (html.match(/katex/g) ?? []).length;
		expect(katexCount).toBeGreaterThanOrEqual(2);
		expect(html).toContain('alt="alt $x$"');
	});

	it("keeps multi-line display math as plain TeX in image alt without losing $", () => {
		// 複数行 display math は preprocess の placeholder として alt に入る経路。
		// 原文復元の replacement に `$$` が含まれるため、文字列 replacement の
		// 特殊パターン解釈（$$ → $）で $ が欠ける回帰を防ぐ（関数形式で回避）。
		const html = markdownToHtml("![alt $$x\n+y$$](u.png)", { breaks: true });
		expect(html).toContain('alt="alt $$x\n+y$$"');
		const imgMatch = html.match(/<img[^>]*>/);
		expect(imgMatch).not.toBeNull();
		expect(imgMatch?.[0]).not.toContain("katex");
	});

	it("does not duplicate document content when TeX contains a $` sequence", () => {
		// KaTeX annotation には TeX 原文が入るため、placeholder 復元が文字列
		// replacement だと「$`」が『マッチ前の全文』として展開され文書が複製される。
		// 関数形式での復元によりリテラルのまま挿入されることを固定する。
		const html = markdownToHtml("before $a\\$`b$ after", { breaks: true });
		expect(html).toContain("katex");
		expect((html.match(/before/g) ?? []).length).toBe(1);
		expect((html.match(/after/g) ?? []).length).toBe(1);
	});
});
