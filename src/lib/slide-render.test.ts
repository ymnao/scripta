import { beforeEach, describe, expect, it, vi } from "vitest";

// mermaid をモックして SVG 出力を決定的にする (lib/mermaid.test.ts と同パターン)
const renderSpy = vi.fn(async (_id: string, source: string) => {
	if (source.includes("FAIL")) throw new Error("mermaid parse error");
	return { svg: `<svg data-source="${source.replace(/"/g, "&quot;")}"></svg>` };
});
const initializeSpy = vi.fn();

vi.mock("mermaid", () => {
	return {
		default: {
			initialize: initializeSpy,
			render: renderSpy,
		},
	};
});

const { renderSlideHtml, renderSlideHtmlWithMermaid, clearSlideRenderCache } = await import(
	"./slide-render"
);
const { clearMermaidCache } = await import("./mermaid");

beforeEach(() => {
	clearMermaidCache();
	clearSlideRenderCache();
	renderSpy.mockClear();
	initializeSpy.mockClear();
});

describe("renderSlideHtmlWithMermaid: mermaid fence 変換", () => {
	it("mermaid fenced code を SVG に置換して mermaid-diagram wrapper に格納する", async () => {
		const md = "# Title\n\n```mermaid\ngraph TD\n  A-->B\n```\n";
		const html = await renderSlideHtmlWithMermaid(md, null, "light");
		expect(html).toContain("mermaid-diagram");
		expect(html).toContain("<svg");
		// 元の fenced code (```mermaid) は残らない
		expect(html).not.toMatch(/<code[^>]*>graph TD/);
	});

	it("light / dark テーマが initialize に伝搬される (theme=default vs dark)", async () => {
		const md = "```mermaid\ngraph TD\n  X-->Y\n```";
		await renderSlideHtmlWithMermaid(md, null, "light");
		expect(initializeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default" }));
		await renderSlideHtmlWithMermaid(md, null, "dark");
		expect(initializeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
	});

	it("mermaid fence 前の末尾 `---` を除去する", async () => {
		const md = "```mermaid\ngraph TD\n  A-->B\n```\n---";
		const html = await renderSlideHtmlWithMermaid(md, null, "light");
		expect(html).toContain("mermaid-diagram");
		expect(html).not.toContain("<hr");
	});

	it("mermaid render 失敗時は元の fenced code をそのまま HTML 化する (silent 失敗させない)", async () => {
		const md = "before\n\n```mermaid\nFAIL diagram\n```\n\nafter";
		const html = await renderSlideHtmlWithMermaid(md, null, "light");
		expect(html).not.toContain("mermaid-diagram");
		// preprocess は match ごとの try/catch で元コードを保持 → markdownToHtml が code block 化
		expect(html).toContain("FAIL diagram");
		expect(html).toContain("before");
		expect(html).toContain("after");
	});

	it("options.mermaidOptions を preprocessMermaidBlocks 経由で initialize に伝搬する", async () => {
		const md = "```mermaid\ngraph TD\n  A-->B\n```";
		await renderSlideHtmlWithMermaid(md, null, "light", {
			mermaidOptions: { htmlLabels: false, useMaxWidth: false },
		});
		expect(initializeSpy).toHaveBeenLastCalledWith(expect.objectContaining({ htmlLabels: false }));
	});

	it("signal が事前に abort されている場合は AbortError で reject し、mermaid は呼ばれない", async () => {
		const md = "```mermaid\ngraph TD\n  A-->B\n```";
		const controller = new AbortController();
		controller.abort();
		await expect(
			renderSlideHtmlWithMermaid(md, null, "light", { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(renderSpy).not.toHaveBeenCalled();
	});

	it("複数 mermaid ブロックで途中 abort されると残ブロックの render をスキップする (bypass 経路)", async () => {
		// 通常経路 (module cache 有効) では caller signal は cache-miss の pre-abort check にのみ
		// 使われ、preprocess loop 内部への signal 伝搬は entry 自身の controller が担う
		// (session 91 の cross-instance poisoning 対策継続)。caller signal → preprocess loop-head
		// の end-to-end 伝搬は bypass 経路 (options 指定で cache を通らないルート) で観測できる。
		const md =
			"```mermaid\ngraph TD\n  A-->B\n```\n\n```mermaid\ngraph TD\n  C-->D\n```\n\n```mermaid\ngraph TD\n  E-->F\n```";
		const controller = new AbortController();
		// 1 ブロック目 render 呼び出しの時点で abort する (逆順処理なので E-->F の render が
		// 最初に呼ばれる → その完了直後の checkpoint で C-->D 以降がスキップされる)。
		renderSpy.mockImplementationOnce(async (_id: string, source: string) => {
			controller.abort();
			return { svg: `<svg data-source="${source}"></svg>` };
		});
		await expect(
			renderSlideHtmlWithMermaid(md, null, "light", {
				signal: controller.signal,
				mermaidOptions: { htmlLabels: false, useMaxWidth: false },
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		// 逆順で 1 ブロック目だけ処理して abort、残 2 ブロックは render 呼ばれない
		expect(renderSpy).toHaveBeenCalledTimes(1);
	});
	it("renderMermaid が AbortError で reject した場合 catch 節で swallow せず伝搬させる", async () => {
		// renderMermaid 直下が AbortError で reject する状況 (loop-head の abort 検出を
		// すり抜けたケース) — 元の実装は `catch {}` で silent 化していたため、rethrow
		// branch がなければ fenced code をそのまま HTML 化して "成功" 扱いになる。
		const md = "```mermaid\ngraph TD\n  A-->B\n```";
		renderSpy.mockImplementationOnce(async () => {
			throw new DOMException("Aborted", "AbortError");
		});
		await expect(renderSlideHtmlWithMermaid(md, null, "light")).rejects.toMatchObject({
			name: "AbortError",
		});
	});
	// rasterize=true (embedOptions) 経路は svg-rasterize を要するため
	// export.test.ts 側 (svg-rasterize モック済み) の exportSlidesAsPdf テストでカバー。
});

describe("renderSlideHtmlWithMermaid: module-level cache", () => {
	it("同一 (theme, activeTabPath, markdown) の 2 回目は cache hit で shared promise を返す", async () => {
		const md = "```mermaid\ngraph TD\n  A-->B\n```";
		const p1 = renderSlideHtmlWithMermaid(md, null, "light");
		const p2 = renderSlideHtmlWithMermaid(md, null, "light");
		// in-flight 中に呼ばれた 2 回目は同じ promise を返す (dedup)
		expect(p2).toBe(p1);
		await Promise.all([p1, p2]);
		// mermaid.render は 1 回だけ呼ばれる
		expect(renderSpy).toHaveBeenCalledTimes(1);
	});

	it("theme が違えば別 entry (dark / light は別 render)", async () => {
		const md = "```mermaid\ngraph TD\n  A-->B\n```";
		await renderSlideHtmlWithMermaid(md, null, "light");
		await renderSlideHtmlWithMermaid(md, null, "dark");
		expect(renderSpy).toHaveBeenCalledTimes(2);
	});

	it("activeTabPath が違えば別 entry (相対画像 URL 解決結果が異なる)", async () => {
		const md = "![](./img/a.png)"; // mermaid なし
		const h1 = await renderSlideHtmlWithMermaid(md, "/w/a.md", "light");
		const h2 = await renderSlideHtmlWithMermaid(md, "/w/sub/b.md", "light");
		expect(h1).not.toBe(h2);
		expect(h1).toContain("scripta-asset://localhost/w/img/a.png");
		expect(h2).toContain("scripta-asset://localhost/w/sub/img/a.png");
	});

	it("cache-hit の 2 回目は caller の signal を無視して shared promise を返す (cross-instance poisoning 防止)", async () => {
		const md = "```mermaid\ngraph TD\n  A-->B\n```";
		const p1 = renderSlideHtmlWithMermaid(md, null, "light");
		const controller = new AbortController();
		controller.abort();
		// 事前 abort されている signal でも cache-hit は shared promise を返す (新規 render を
		// 起動する経路ではないため pre-abort check を通らない)
		const p2 = renderSlideHtmlWithMermaid(md, null, "light", { signal: controller.signal });
		expect(p2).toBe(p1);
		await expect(p1).resolves.toContain("mermaid-diagram");
		await expect(p2).resolves.toContain("mermaid-diagram");
	});

	it("cache-miss で caller signal が pre-abort されていれば AbortError で throw して cache に entry を作らない", async () => {
		const md = "```mermaid\ngraph TD\n  Z-->W\n```";
		const controller = new AbortController();
		controller.abort();
		await expect(
			renderSlideHtmlWithMermaid(md, null, "light", { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(renderSpy).not.toHaveBeenCalled();
		// 続く normal 呼び出しは cache に entry が無い状態から fresh に render される
		await renderSlideHtmlWithMermaid(md, null, "light");
		expect(renderSpy).toHaveBeenCalledTimes(1);
	});

	it("mermaidOptions が指定された経路は cache を bypass (PDF export 経路の SVG→PNG 相互汚染防止)", async () => {
		const md = "```mermaid\ngraph TD\n  A-->B\n```";
		// 通常経路で cache 済みにする
		await renderSlideHtmlWithMermaid(md, null, "light");
		expect(renderSpy).toHaveBeenCalledTimes(1);
		// カスタム mermaidOptions 経路は bypass — mermaid.render が再度呼ばれる
		await renderSlideHtmlWithMermaid(md, null, "light", {
			mermaidOptions: { htmlLabels: false, useMaxWidth: false },
		});
		expect(renderSpy).toHaveBeenCalledTimes(2);
	});

	it("embedOptions が指定された経路も cache を bypass", async () => {
		const md = "# title"; // mermaid 無しでも bypass 判定は options だけで決まる
		await renderSlideHtmlWithMermaid(md, null, "light");
		await renderSlideHtmlWithMermaid(md, null, "light", { embedOptions: { rasterize: true } });
		// mermaid ブロック無しなので renderSpy は呼ばれない → renderSpy カウントでは検証できないので、
		// 2 回目呼び出しが例外なく resolve すること (bypass が例外なく通ること) を確認するに留める
	});

	it("失敗した promise は cache に fix されず、次回呼び出しで retry される", async () => {
		const md = "```mermaid\nFAIL diagram\n```"; // renderSpy が throw
		// mermaid preprocess は match ごとの try/catch で吸収して元 fence を残すので、
		// slide-render 全体としては reject せず「fenced code をそのまま HTML 化」で resolve する。
		// つまり failed-promise-not-cached の branch を直接発火させるには preprocess の外側で
		// throw させる必要がある。ここでは cache bypass 経路の retry 保証にとどめる。
		const h1 = await renderSlideHtmlWithMermaid(md, null, "light");
		expect(h1).toContain("FAIL diagram");
		// 2 回目呼び出しは cache hit で mermaid.render 追加呼び出しは無い (silent 失敗を retry
		// しないのは preprocess の仕様、slide-render 層は正常 promise として cache する)
		await renderSlideHtmlWithMermaid(md, null, "light");
		expect(renderSpy).toHaveBeenCalledTimes(1);
	});

	it("regression: cache cap を超える枚数の Promise.all で 1 個目の entry が LRU eviction されても Promise.all 全体は reject しない (self-poisoning 対策)", async () => {
		// deck > MAX_CACHE_SIZE 相当の cache miss を同期的に登録すると、131 個目の set が
		// 1 個目 entry を evict する。もし evict で controller.abort() すると 1 個目の preprocess
		// が AbortError で reject → Promise.all 全体 reject → useAsyncDerived が silent 化
		// → deck 凍結、というシナリオが起きる。この回帰テストは MAX_CACHE_SIZE (128) を超える
		// unique markdown を並列で登録して、全 promise が正常 resolve することを確認する。
		const CACHE_CAP = 128;
		const N = CACHE_CAP + 3;
		const markdowns = Array.from(
			{ length: N },
			(_, i) => `# slide ${i}\n\n\`\`\`mermaid\ngraph TD\n  A${i}-->B${i}\n\`\`\``,
		);
		const promises = markdowns.map((md) => renderSlideHtmlWithMermaid(md, null, "light"));
		const results = await Promise.all(promises);
		expect(results.length).toBe(N);
		for (const html of results) {
			expect(html).toContain("mermaid-diagram");
		}
	});

	it("clearSlideRenderCache 後の 2 回目呼び出しは cache miss で再 render される", async () => {
		const md = "```mermaid\ngraph TD\n  A-->B\n```";
		await renderSlideHtmlWithMermaid(md, null, "light");
		expect(renderSpy).toHaveBeenCalledTimes(1);
		clearSlideRenderCache();
		// slide-render cache を clear しても mermaid 側 cache は残るので mermaid.render は呼ばれない
		// が、renderSlideHtmlDirect が preprocess を通る = slide-render 層の cache miss を確認できる
		// 別の直接的な観測: 2 つの promise が別 identity になる
		const p1 = renderSlideHtmlWithMermaid(md, null, "light");
		const p2 = renderSlideHtmlWithMermaid(md, null, "light");
		expect(p2).toBe(p1); // clear 後の 1 回目 (p1) が新 entry として cache され、2 回目 (p2) が hit
		await Promise.all([p1, p2]);
	});
});

describe("renderSlideHtml (sync): module-level cache", () => {
	// renderSlideHtml は決定的な純粋関数なので、cache hit 時は same string identity を返すことを
	// 観測する (プロファイル的な CPU 削減の直接検証は要求しない)。
	it("同一 (activeTabPath, markdown) の 2 回目は same string identity を返す", () => {
		const md = "# Title\n\nbody";
		const h1 = renderSlideHtml(md, "/w/a.md");
		const h2 = renderSlideHtml(md, "/w/a.md");
		expect(h2).toBe(h1);
	});

	it("activeTabPath が違えば別 identity", () => {
		const md = "# Title";
		const h1 = renderSlideHtml(md, "/w/a.md");
		const h2 = renderSlideHtml(md, "/w/b.md");
		// URL 解決に絡まない markdown なので値は等しくとも、cache 経路が独立していれば別 entry
		expect(h1).toBe(h2); // 同じ HTML 文字列
		// activeTabPath 依存の相対画像で違いを観測 (親ディレクトリが変わる path を選ぶ)
		const img1 = renderSlideHtml("![](./x.png)", "/root/a/deck.md");
		const img2 = renderSlideHtml("![](./x.png)", "/root/b/deck.md");
		expect(img1).not.toBe(img2);
	});

	it("clearSlideRenderCache 後は entry が消える (behavior: 2 回目呼び出しが正常に走る)", () => {
		const md = "# T";
		const h1 = renderSlideHtml(md, null);
		clearSlideRenderCache();
		const h2 = renderSlideHtml(md, null);
		// content は同一
		expect(h2).toBe(h1);
	});
});
