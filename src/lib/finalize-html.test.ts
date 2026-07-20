import { describe, expect, it } from "vitest";
import { finalizeHtml, markUnsanitized } from "./finalize-html";

describe("finalizeHtml", () => {
	describe("XSS ベクタ", () => {
		it("<script> を strip する", () => {
			const html = finalizeHtml(markUnsanitized("<p>ok</p><script>alert(1)</script>"));
			expect(html).toBe("<p>ok</p>");
		});

		it("on* イベントハンドラを strip する", () => {
			const html = finalizeHtml(markUnsanitized('<img src="x" onerror="alert(1)">'));
			expect(html).not.toContain("onerror");
		});

		it("javascript: scheme を strip する (default 経路)", () => {
			const html = finalizeHtml(markUnsanitized('<a href="javascript:alert(1)">x</a>'));
			expect(html).not.toContain("javascript:");
		});

		it("data:text/html scheme を strip する", () => {
			const html = finalizeHtml(
				markUnsanitized('<img src="data:text/html,<script>alert(1)</script>">'),
			);
			expect(html).not.toContain("data:text/html");
		});
	});

	describe("URI scheme allow", () => {
		it("default では scripta-asset: を strip する", () => {
			const html = finalizeHtml(markUnsanitized('<img src="scripta-asset://foo.png">'));
			expect(html).not.toContain("scripta-asset");
		});

		it("allowAssetProtocol: true で scripta-asset: を通す", () => {
			const html = finalizeHtml(markUnsanitized('<img src="scripta-asset://foo.png">'), {
				allowAssetProtocol: true,
			});
			expect(html).toContain("scripta-asset://foo.png");
		});

		// DOMPurify default の DATA_URI_TAGS が <img> 等の data:image/* を許可するため、
		// HTML export 経路では追加オプション無しでそのまま通過する。
		it("<img> の data:image/png を通す (default 挙動、HTML export 用)", () => {
			const html = finalizeHtml(markUnsanitized('<img src="data:image/png;base64,AAAA">'));
			expect(html).toContain("data:image/png;base64,AAAA");
		});

		it("http/https/相対 src は default で通す", () => {
			const html = finalizeHtml(
				markUnsanitized(
					'<img src="https://example.com/a.png"><img src="./local.png"><a href="mailto:a@b">m</a>',
				),
			);
			expect(html).toContain("https://example.com/a.png");
			expect(html).toContain("./local.png");
			expect(html).toContain("mailto:a@b");
		});
	});

	describe("KaTeX allowlist", () => {
		it("KaTeX span + MathML tag/attr を通す", () => {
			const katexLike =
				'<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi></mrow><annotation encoding="application/x-tex">x</annotation></semantics></math></span></span>';
			const html = finalizeHtml(markUnsanitized(katexLike));
			expect(html).toContain("katex-mathml");
			expect(html).toContain("<math");
			expect(html).toContain("<semantics");
			expect(html).toContain("<mrow");
			expect(html).toContain("<mi");
			expect(html).toContain("<annotation");
			expect(html).toContain('encoding="application/x-tex"');
		});
	});

	describe("冪等性", () => {
		it("finalize を 2 回呼んでも結果が変わらない", () => {
			const raw = markUnsanitized(
				'<p>hello</p><img src="scripta-asset://a.png"><span class="katex">x</span>',
			);
			const once = finalizeHtml(raw, { allowAssetProtocol: true });
			const twice = finalizeHtml(markUnsanitized(once), { allowAssetProtocol: true });
			expect(twice).toBe(once);
		});
	});
});
