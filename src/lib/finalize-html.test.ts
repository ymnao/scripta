import katex from "katex";
import { describe, expect, it } from "vitest";
import { finalizeHtml, markUnsanitized } from "./finalize-html";
import { markdownToHtmlRaw } from "./markdown-to-html";
import { resolveHtmlImageSrcs } from "./resolve-html-images";

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

		// allowAssetProtocol:true 経路は ALLOWED_URI_REGEXP を独自版に差し替える分岐なので、
		// 基本 XSS ベクタ (script / on* / javascript: / data:text/html) が引き続き除去されることを固定する
		// (default 経路のテストだけでは合成 regexp の書き間違いで javascript: が通っても検出できない)。
		it("allowAssetProtocol: true でも <script> / on* / javascript: / data:text/html を strip する", () => {
			const attacks =
				"<script>alert(1)</script>" +
				'<img src="x" onerror="alert(1)">' +
				'<a href="javascript:alert(1)">j</a>' +
				'<img src="data:text/html,<script>alert(1)</script>">';
			const html = finalizeHtml(markUnsanitized(attacks), { allowAssetProtocol: true });
			expect(html).not.toContain("<script");
			expect(html).not.toContain("onerror");
			expect(html).not.toContain("javascript:");
			expect(html).not.toContain("data:text/html");
			// 期待 scheme (scripta-asset:) は同じ経路で通ることも確認 (regexp 合成の正常系)
			const good = finalizeHtml(markUnsanitized('<img src="scripta-asset://a.png">'), {
				allowAssetProtocol: true,
			});
			expect(good).toContain("scripta-asset://a.png");
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

		// KaTeX の実出力 (分数・平方根・上下添字・行列) を finalize に通し、
		// 期待 tag / annotation の TeX 原文が保持されることを固定する。KaTeX 更新で
		// 新 tag/attr が加わった際、この test の期待と実出力の差分で気付ける safety net。
		it("実 KaTeX 出力 (\\frac / \\sqrt / \\overset / \\begin{matrix}) を通す", () => {
			for (const [name, tex] of [
				["frac", "\\frac{a}{b}"],
				["sqrt", "\\sqrt{x}"],
				["overset", "\\overset{y}{x}"],
				["matrix", "\\begin{pmatrix}a & b\\\\c & d\\end{pmatrix}"],
			] as const) {
				const raw = katex.renderToString(tex, { displayMode: true, throwOnError: false });
				const html = finalizeHtml(markUnsanitized(raw));
				expect(html, `${name} contains <math`).toContain("<math");
				expect(html, `${name} contains <semantics`).toContain("<semantics");
				// annotation encoding は KaTeX の representation 保持に必須
				expect(html, `${name} contains encoding attr`).toContain('encoding="application/x-tex"');
			}
		});
	});

	// sanitize-after pattern の本体挙動: markdownToHtmlRaw → post-processor
	// (`resolveHtmlImageSrcs`) → finalizeHtml の合成経路で、post-processor が挿入する
	// scripta-asset: を保持しつつ XSS ベクタ (script / on* / javascript:) を除去する
	// 完全 pipeline レベルの安全性を固定する。単体テストが分断されているため、
	// pipeline 段の境界で mutation を跨ぐ regression をこの test で捕まえる。
	describe("integrated pipeline (markdownToHtmlRaw → resolveHtmlImageSrcs → finalizeHtml)", () => {
		it("XSS ベクタを除去しつつ、post-processor が書いた scripta-asset src を保持する", () => {
			const md = [
				"![alt](./local.png)",
				"",
				"<script>alert(1)</script>",
				'<img src="x" onerror="alert(1)">',
				'<a href="javascript:alert(1)">j</a>',
			].join("\n");
			const raw = markdownToHtmlRaw(md);
			const withAsset = resolveHtmlImageSrcs(raw, "/workspace/deck.md");
			const html = finalizeHtml(withAsset, { allowAssetProtocol: true });
			// post-processor が挿入する asset URL は最終 sanitize でも保持される
			expect(html).toContain("scripta-asset://");
			// 悪意ベクタは pipeline 全体で除去される (executable な形での残存を許さない)
			expect(html).not.toContain("<script");
			expect(html).not.toContain("onerror");
			// href="javascript:..." が active link として残らないこと (marked が literal 化した
			// 表示テキストは safe だが、finalize 後の HTML で href attribute として復活しないこと)
			expect(html).not.toMatch(/href\s*=\s*"[^"]*javascript:/);
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
