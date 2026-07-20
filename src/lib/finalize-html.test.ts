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

	// `allowAssetProtocol: true` は `ALLOWED_URI_REGEXP` を差し替える分岐で、
	// regexp レベルでは tag/attr の限定を持たない。DOMPurify の tag allowlist
	// (default で <link>/<iframe>/<object>/<embed> 等を strip) にのみ依存する形。
	// 現状挙動を仕様として固定し、post-processor が挿入する `scripta-asset://`
	// が意図しない sink へ広がっていないか regression 検知する。
	describe("allowAssetProtocol: true の tag スコープ (仕様固定)", () => {
		const finalize = (html: string) =>
			finalizeHtml(markUnsanitized(html), { allowAssetProtocol: true });

		// 想定 sink: post-processor が実際に挿入するのは <img src> のみだが、
		// 手書き HTML で以下 tag に scripta-asset: を書いた場合も通過する。
		// この経路の caller (preview / PDF export) は custom protocol の解決を
		// 提供しており、既存の image/media 経路に閉じる想定なので許容。
		it("media/source/anchor/form で scripta-asset: が通過する (現仕様)", () => {
			expect(finalize('<img src="scripta-asset://a.png">')).toContain("scripta-asset://a.png");
			expect(finalize('<img srcset="scripta-asset://b.png 2x">')).toContain(
				"scripta-asset://b.png",
			);
			expect(finalize('<video src="scripta-asset://c.mp4"></video>')).toContain(
				"scripta-asset://c.mp4",
			);
			expect(finalize('<audio src="scripta-asset://d.mp3"></audio>')).toContain(
				"scripta-asset://d.mp3",
			);
			expect(finalize('<source src="scripta-asset://e.png">')).toContain("scripta-asset://e.png");
			// <a href> は clickable link として通過するが、preview / PDF 経路は外部遷移を
			// 持たない (Electron webview で custom protocol 解決) ため許容範囲。
			expect(finalize('<a href="scripta-asset://f.png">x</a>')).toContain("scripta-asset://f.png");
			// <form action> も通過する。preview/PDF 経路で form submit は起きないため許容。
			expect(finalize('<form action="scripta-asset://g"></form>')).toContain("scripta-asset://g");
		});

		// DOMPurify default の tag allowlist に無い危険 sink は、URI regexp を差し替えても
		// tag ごと strip される。ここが後日 default 変更等で緩んだ場合の safety net。
		it("script リソース sink (<link>/<iframe>/<object>/<embed>) は tag ごと strip される", () => {
			// tag そのものの残存も否定して、DOMPurify default 更新で「tag は残すが URI だけ剥がす」
			// 挙動になった場合の silent pass を防ぐ (comment で宣言している tag-scope を正確に固定)。
			const link = finalize('<link rel="stylesheet" href="scripta-asset://x.css">');
			expect(link).not.toContain("scripta-asset");
			expect(link).not.toContain("<link");
			const iframe = finalize('<iframe src="scripta-asset://x.html"></iframe>');
			expect(iframe).not.toContain("scripta-asset");
			expect(iframe).not.toContain("<iframe");
			const object = finalize('<object data="scripta-asset://x"></object>');
			expect(object).not.toContain("scripta-asset");
			expect(object).not.toContain("<object");
			const embed = finalize('<embed src="scripta-asset://x">');
			expect(embed).not.toContain("scripta-asset");
			expect(embed).not.toContain("<embed");
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

	// #368: `data:image/svg+xml` は payload に script / event handler を含み得るため、
	// `data:image/png` とは MIME レベルで security posture が異なる。DOMPurify の
	// `<img>` 経路は data:image/svg+xml を allow するが、この経路はブラウザが `<img>`
	// referenced SVG 上で script を実行しないという仕様に依拠して安全と扱う。
	// 現挙動を仕様として固定し、DOMPurify default 変更 (svg data URI を strip する等)
	// に silent 追従しないための safety net。
	describe("SVG data URI (仕様固定)", () => {
		it("<img> の data:image/svg+xml (空 svg) を通す", () => {
			// PHN2Zy8+ = base64("<svg/>")
			const html = finalizeHtml(markUnsanitized('<img src="data:image/svg+xml;base64,PHN2Zy8+">'));
			expect(html).toContain("data:image/svg+xml;base64,PHN2Zy8+");
		});

		it("<img> の data:image/svg+xml payload に <script> があっても URL は保持する (img sink は script 実行しない仕様)", () => {
			// base64("<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>")
			const svgB64 =
				"PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxzY3JpcHQ+YWxlcnQoMSk8L3NjcmlwdD48L3N2Zz4=";
			const html = finalizeHtml(markUnsanitized(`<img src="data:image/svg+xml;base64,${svgB64}">`));
			// URL 自体は attribute value として保持される (script は payload 内であり finalize 対象外)
			expect(html).toContain(`data:image/svg+xml;base64,${svgB64}`);
			// finalize 出力の HTML レベルで <script> tag が実体化していないことは
			// base64 のままで保証されるが、念のため裸の <script が出ないことも固定
			expect(html).not.toMatch(/<script/i);
		});

		it("<img> の data:image/svg+xml payload に on* があっても URL は保持する", () => {
			// base64("<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"></svg>")
			const svgB64 =
				"PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIG9ubG9hZD0iYWxlcnQoMSkiPjwvc3ZnPg==";
			const html = finalizeHtml(markUnsanitized(`<img src="data:image/svg+xml;base64,${svgB64}">`));
			expect(html).toContain(`data:image/svg+xml;base64,${svgB64}`);
			// finalize 経路では base64 は decode されないため、attribute 外に onload=... が
			// 漏れないことを念のため固定 (DOMPurify default が base64 を decode して inspect
			// する挙動に変わった場合の regression detector)
			expect(html).not.toMatch(/\bonload\s*=/i);
		});

		it("<img> の data:image/svg+xml;utf8, (URL-encoded payload) も URL を保持する", () => {
			const payload = encodeURIComponent(
				'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
			);
			const html = finalizeHtml(markUnsanitized(`<img src="data:image/svg+xml;utf8,${payload}">`));
			expect(html).toContain(`data:image/svg+xml;utf8,${payload}`);
			expect(html).not.toMatch(/<script/i);
		});
	});

	// #368: `javascript:` の拒否テストが平文小文字のみだった件を補完。
	// 難読化 (HTML entity / 大小文字 / 改行/タブ / 前後空白) を通しても、
	// finalize 出力の HTML から `javascript:` scheme を持つ active な href/src が
	// 残らないことを固定する。
	describe("javascript: 難読化除去", () => {
		// helper: finalize 後の HTML を DOM parse して、全 href/src attribute から
		// ASCII 空白 (改行/タブ含む) と制御文字を除去した上で小文字化した値が、
		// `javascript:` で始まっていないことを assert する。文字列 substring 検査だと
		// `java\nscript:` のような難読化を跨げないため必ず DOM 経由で確認する。
		const assertNoActiveJavascriptScheme = (html: string) => {
			const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
			const elements = doc.querySelectorAll("[href], [src]");
			for (const el of Array.from(elements)) {
				for (const attr of ["href", "src"] as const) {
					const raw = el.getAttribute(attr);
					if (raw == null) continue;
					// scheme 部分に紛れた ASCII whitespace (改行/タブ/前置空白) を剥がしてから
					// 小文字化して判定する。DOMPurify が仮に href/src の scheme 難読化を通した
					// 場合でも substring 検査ではなく scheme 正規化ベースで detect する
					const normalized = raw.replace(/\s/g, "").toLowerCase();
					expect(
						normalized.startsWith("javascript:"),
						`<${el.tagName.toLowerCase()} ${attr}="${raw}"> は active な javascript: を持つ`,
					).toBe(false);
				}
			}
		};

		it("HTML entity で j を難読化した javascript: (java&#x73;cript:) を除去する", () => {
			const html = finalizeHtml(markUnsanitized('<a href="java&#x73;cript:alert(1)">x</a>'));
			assertNoActiveJavascriptScheme(html);
		});

		it("大小文字混在の JavaScript: を除去する", () => {
			const html = finalizeHtml(markUnsanitized('<a href="JavaScript:alert(1)">x</a>'));
			assertNoActiveJavascriptScheme(html);
		});

		it("改行を挟んだ java\\nscript: を除去する", () => {
			const html = finalizeHtml(markUnsanitized('<a href="java\nscript:alert(1)">x</a>'));
			assertNoActiveJavascriptScheme(html);
		});

		it("タブを挟んだ ja\\tvascript: を img src で除去する", () => {
			const html = finalizeHtml(markUnsanitized('<img src="ja\tvascript:alert(1)">'));
			assertNoActiveJavascriptScheme(html);
		});

		it("前置空白 ' javascript:' を除去する", () => {
			const html = finalizeHtml(markUnsanitized('<a href=" javascript:alert(1)">x</a>'));
			assertNoActiveJavascriptScheme(html);
		});

		// allowAssetProtocol: true 経路でも同じく難読化 javascript: が除去されることを
		// 固定する (合成 regexp の書き間違いで難読化パターンだけ通ってしまう regression を検出)。
		it("allowAssetProtocol: true 経路でも難読化 javascript: を除去する", () => {
			const attacks = [
				'<a href="java&#x73;cript:alert(1)">a</a>',
				'<a href="JavaScript:alert(1)">b</a>',
				'<a href="java\nscript:alert(1)">c</a>',
				'<img src="ja\tvascript:alert(1)">',
				'<a href=" javascript:alert(1)">d</a>',
			].join("");
			const html = finalizeHtml(markUnsanitized(attacks), { allowAssetProtocol: true });
			assertNoActiveJavascriptScheme(html);
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
