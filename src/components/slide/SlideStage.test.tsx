import { describe, expect, it } from "vitest";
import { renderSlideHtml, renderSlideHtmlWithMermaid } from "../../lib/slide-render";
import { useWorkspaceStore } from "../../stores/workspace";

describe("renderSlideHtml", () => {
	it("空文字は空を返す", () => {
		expect(renderSlideHtml("", null)).toBe("");
	});

	it("空白のみは空を返す", () => {
		expect(renderSlideHtml("   \n\n  ", null)).toBe("");
	});

	it("末尾の区切り行 `---` を除去する", () => {
		const html = renderSlideHtml("# Title\n---", null);
		expect(html).toContain("Title");
		expect(html).not.toContain("<hr");
	});

	it("本文中の `---` は水平線として保持する", () => {
		const html = renderSlideHtml("above\n\n---\n\nbelow", null);
		// 末尾ではない `---` は markdownToHtml が hr にする
		expect(html).toContain("<hr");
		expect(html).toContain("above");
		expect(html).toContain("below");
	});

	it("activeTabPath 基準で相対画像 URL を解決する", () => {
		// resolve-html-images は scripta-asset://localhost/... に書き換える
		const html = renderSlideHtml("![](./img/a.png)", "/workspace/notes/deck.md");
		expect(html).toContain("scripta-asset://localhost/workspace/notes/img/a.png");
	});

	it("activeTabPath が null なら相対 URL はそのまま", () => {
		// resolveHtmlImageSrcs は activeTabPath なしなら書き換えない
		const html = renderSlideHtml("![](./img/a.png)", null);
		expect(html).toContain('src="./img/a.png"');
	});
});

describe("renderSlideHtmlWithMermaid", () => {
	it("mermaid ブロックが無ければ sync 版と同じ結果を返す", async () => {
		const sync = renderSlideHtml("# Title\n\nbody", null);
		const asyncHtml = await renderSlideHtmlWithMermaid("# Title\n\nbody", null, "light");
		expect(asyncHtml).toBe(sync);
	});

	it("空文字は空を返す", async () => {
		expect(await renderSlideHtmlWithMermaid("", null, "light")).toBe("");
		expect(await renderSlideHtmlWithMermaid("   \n\n  ", null, "dark")).toBe("");
	});

	it("末尾の区切り行 `---` は除去される", async () => {
		const html = await renderSlideHtmlWithMermaid("# Title\n---", null, "light");
		expect(html).toContain("Title");
		expect(html).not.toContain("<hr");
	});
});

describe("useSlideHtml 前提 (workspace store 副作用)", () => {
	// useSlideHtml 自体は useMemo + useWorkspaceStore selector で薄いラッパー。
	// 純粋関数 renderSlideHtml の網羅で本体ロジックは担保しつつ、workspace store
	// 側のリセット衛生だけ確認しておく。
	it("workspace store のリセットで activeTabPath が null に戻る", () => {
		useWorkspaceStore.setState({ activeTabPath: "/x/y.md" });
		expect(useWorkspaceStore.getState().activeTabPath).toBe("/x/y.md");
		useWorkspaceStore.setState({ activeTabPath: null });
		expect(useWorkspaceStore.getState().activeTabPath).toBeNull();
	});
});
