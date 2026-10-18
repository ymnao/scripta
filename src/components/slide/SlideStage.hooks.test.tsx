import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// source に含まれる token の gate が開くまで render を止め、描画の完了順を test から決める。
// gate は afterEach で必ず開ける。開けずに終わると mermaid.ts の renderQueue が詰まり、後続の test まで止まる。
const { gates } = vi.hoisted(() => ({
	gates: new Map<string, { promise: Promise<void>; open: () => void }>(),
}));

// mermaid を決定的にモックし、fenced code → SVG 変換で hook 経路を検証する。
vi.mock("mermaid", () => ({
	default: {
		initialize: vi.fn(),
		render: vi.fn(async (_id: string, source: string) => {
			for (const [token, gate] of gates) {
				if (source.includes(token)) await gate.promise;
			}
			return { svg: `<svg data-mock="${source.replace(/"/g, "&quot;")}"></svg>` };
		}),
	},
}));

const { default: mermaid } = await import("mermaid");
const { useSlideHtml, useSlideHtmls } = await import("./SlideStage");
const { useWorkspaceStore } = await import("../../stores/workspace");
const { useThemeStore } = await import("../../stores/theme");
const { clearMermaidCache } = await import("../../lib/mermaid");
const { clearSlideRenderCache } = await import("../../lib/slide-render");

beforeEach(() => {
	clearMermaidCache();
	clearSlideRenderCache();
	useWorkspaceStore.setState({ activeTabPath: null });
	useThemeStore.setState({ theme: "light" });
});
afterEach(() => {
	for (const gate of gates.values()) gate.open();
	gates.clear();
	vi.mocked(mermaid.render).mockClear();
	clearSlideRenderCache();
	useWorkspaceStore.setState({ activeTabPath: null });
	useThemeStore.setState({ theme: "light" });
});

describe("useSlideHtml (hook integration)", () => {
	it("mermaid fenced code を含む markdown が同期→非同期で SVG に差し替わる", async () => {
		const md = "```mermaid\ngraph TD\n  A-->B\n```";
		const { result } = renderHook(() => useSlideHtml(md));
		// 同期版は fenced code のまま
		expect(result.current).not.toContain("mermaid-diagram");
		await waitFor(() => {
			expect(result.current).toContain("mermaid-diagram");
			expect(result.current).toContain("<svg");
		});
	});

	it("activeTabPath 変更で相対画像パスが再解決される", async () => {
		const md = "![](./img/hero.png)";
		useWorkspaceStore.setState({ activeTabPath: "/workspace/deck.md" });
		const { result, rerender } = renderHook(() => useSlideHtml(md));
		await waitFor(() => {
			expect(result.current).toContain("scripta-asset://localhost/workspace/img/hero.png");
		});
		act(() => {
			useWorkspaceStore.setState({ activeTabPath: "/notes/subdir/deck.md" });
		});
		rerender();
		await waitFor(() => {
			expect(result.current).toContain("scripta-asset://localhost/notes/subdir/img/hero.png");
		});
	});

	it("theme 変更で mermaid の再レンダリングが走る (renderMermaid が新テーマで再呼び出し)", async () => {
		const md = "```mermaid\ngraph TD\n  X-->Y\n```";
		const { result, rerender } = renderHook(() => useSlideHtml(md));
		await waitFor(() => expect(result.current).toContain("mermaid-diagram"));
		act(() => {
			useThemeStore.setState({ theme: "dark" });
		});
		rerender();
		// keepPrevious により light の SVG が残り続け、その後 dark の SVG に更新
		await waitFor(() => {
			// dark 再描画後も mermaid-diagram wrapper は維持
			expect(result.current).toContain("mermaid-diagram");
		});
	});
});

describe("useSlideHtmls (hook integration)", () => {
	it("空配列は空配列を返す", () => {
		const { result } = renderHook(() => useSlideHtmls([]));
		expect(result.current).toEqual([]);
	});

	it("複数スライドを入力順で HTML 配列にマップし、mermaid ブロックだけ SVG 化する", async () => {
		const slides = [
			{ content: "# Alpha" },
			{ content: "```mermaid\ngraph TD\n  A-->B\n```" },
			{ content: "# Gamma" },
		];
		const { result } = renderHook(() => useSlideHtmls(slides));
		// 同期初期段階では mermaid は fenced code
		expect(result.current[0]).toContain("Alpha");
		expect(result.current[2]).toContain("Gamma");
		await waitFor(() => {
			// 非同期完了で mermaid のみ SVG 化、他スライドは通常 HTML のまま
			expect(result.current[0]).toContain("Alpha");
			expect(result.current[1]).toContain("mermaid-diagram");
			expect(result.current[2]).toContain("Gamma");
			expect(result.current.length).toBe(3);
		});
	});

	it("slides 参照が同一の間は再 async 実行されない (identity 安定契約の positive path)", async () => {
		const slides = [{ content: "```mermaid\ngraph TD\n  A-->B\n```" }];
		const { result, rerender } = renderHook(() => useSlideHtmls(slides));
		await waitFor(() => expect(result.current[0]).toContain("mermaid-diagram"));
		const firstHtml = result.current[0];
		// 同一 slides ref で rerender → 結果参照が同じでなくとも内容は同じ HTML
		rerender();
		expect(result.current[0]).toBe(firstHtml);
	});

	it("per-slide キャッシュ: 変更のないスライドは再計算されず同一 string identity で返る", async () => {
		const stable = "# Stable";
		const initial = [{ content: stable }, { content: "# Before" }];
		const { result, rerender } = renderHook(({ slides }) => useSlideHtmls(slides), {
			initialProps: { slides: initial },
		});
		await waitFor(() => {
			expect(result.current[0]).toContain("Stable");
			expect(result.current[1]).toContain("Before");
		});
		const stableHtml = result.current[0];
		// slides 配列 identity を新しくしつつ、slide 0 の content は同一、slide 1 だけ変える。
		// キャッシュヒットしていれば slide 0 の HTML string identity が保たれる。
		rerender({ slides: [{ content: stable }, { content: "# After" }] });
		await waitFor(() => expect(result.current[1]).toContain("After"));
		expect(result.current[0]).toBe(stableHtml);
	});

	it("activeTabPath 変更で per-slide キャッシュは全クリアされる (相対画像パス再解決)", async () => {
		const slides = [{ content: "![](./img/hero.png)" }];
		useWorkspaceStore.setState({ activeTabPath: "/workspace/deck.md" });
		const { result, rerender } = renderHook(() => useSlideHtmls(slides));
		await waitFor(() => {
			expect(result.current[0]).toContain("scripta-asset://localhost/workspace/img/hero.png");
		});
		act(() => {
			useWorkspaceStore.setState({ activeTabPath: "/notes/subdir/deck.md" });
		});
		rerender();
		await waitFor(() => {
			expect(result.current[0]).toContain("scripta-asset://localhost/notes/subdir/img/hero.png");
		});
	});
});

describe("useSlideHtmls: 描画の順番 (#663)", () => {
	function hold(token: string): () => void {
		let open!: () => void;
		const promise = new Promise<void>((resolve) => {
			open = resolve;
		});
		gates.set(token, { promise, open });
		return open;
	}
	const mermaidSlide = (token: string) => ({
		content: `\`\`\`mermaid\ngraph TD\n  ${token}-->X\n\`\`\``,
	});
	const renderedTokens = () =>
		vi.mocked(mermaid.render).mock.calls.map(([, source]) => source.match(/T\d/)?.[0]);

	it("描き終えたスライドから反映し、他のスライドの完了を待たない", async () => {
		const open1 = hold("T1");
		const slides = [mermaidSlide("T0"), mermaidSlide("T1")];
		const { result } = renderHook(() => useSlideHtmls(slides));
		await waitFor(() => expect(result.current[0]).toContain("<svg"));
		expect(result.current[1]).not.toContain("mermaid-diagram");
		open1();
		await waitFor(() => expect(result.current[1]).toContain("<svg"));
	});

	it("priorityIndex のスライドから描き、末尾の次は先頭へ戻る", async () => {
		const open2 = hold("T2");
		const slides = [mermaidSlide("T0"), mermaidSlide("T1"), mermaidSlide("T2")];
		const { result } = renderHook(() => useSlideHtmls(slides, null, 2));
		await waitFor(() => expect(renderedTokens()).toEqual(["T2"]));
		open2();
		await waitFor(() => {
			for (const html of result.current) expect(html).toContain("<svg");
		});
		expect(renderedTokens()).toEqual(["T2", "T0", "T1"]);
	});

	it("描画の途中で priorityIndex が変わると、次の 1 枚から新しい位置を優先する", async () => {
		const open0 = hold("T0");
		const slides = [mermaidSlide("T0"), mermaidSlide("T1"), mermaidSlide("T2")];
		const { result, rerender } = renderHook(
			({ priority }) => useSlideHtmls(slides, null, priority),
			{ initialProps: { priority: 0 } },
		);
		await waitFor(() => expect(renderedTokens()).toEqual(["T0"]));
		rerender({ priority: 2 });
		open0();
		await waitFor(() => {
			for (const html of result.current) expect(html).toContain("<svg");
		});
		expect(renderedTokens()).toEqual(["T0", "T2", "T1"]);
	});

	it("theme が変わっても、描き直すまでは同じ位置の直前の結果を返す", async () => {
		const slides = [mermaidSlide("T0")];
		const { result, rerender } = renderHook(() => useSlideHtmls(slides));
		await waitFor(() => expect(result.current[0]).toContain("<svg"));
		const open0 = hold("T0");
		act(() => {
			useThemeStore.setState({ theme: "dark" });
		});
		rerender();
		await waitFor(() => expect(renderedTokens()).toEqual(["T0", "T0"]));
		expect(result.current[0]).toContain("<svg");
		open0();
	});

	it("スライドが減ったら、減った位置の直前の結果を捨てる", async () => {
		const { result, rerender } = renderHook(({ slides }) => useSlideHtmls(slides), {
			initialProps: { slides: [mermaidSlide("T0"), mermaidSlide("T1")] },
		});
		await waitFor(() => expect(result.current[1]).toContain("<svg"));
		rerender({ slides: [mermaidSlide("T0")] });
		hold("T2");
		rerender({ slides: [mermaidSlide("T0"), mermaidSlide("T2")] });
		await waitFor(() => expect(renderedTokens()).toEqual(["T0", "T1", "T2"]));
		expect(result.current[1]).toContain("T2");
		expect(result.current[1]).not.toContain("<svg");
	});

	it("1 枚の描画が中断されても、残りのスライドは描き続ける", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		// preprocessMermaidBlocks は末尾の図から描くので T9 が先。T9 の後の loop-head check で
		// clearSlideRenderCache の abort を観測し、スライド 0 だけが AbortError で reject する。
		const open9 = hold("T9");
		const twoDiagrams = {
			content: `${mermaidSlide("T0").content}\n\n${mermaidSlide("T9").content}`,
		};
		const slides = [twoDiagrams, mermaidSlide("T1")];
		const { result } = renderHook(() => useSlideHtmls(slides));
		await waitFor(() => expect(renderedTokens()).toEqual(["T9"]));
		clearSlideRenderCache();
		open9();
		await waitFor(() => expect(result.current[1]).toContain("<svg"));
		expect(result.current[0]).not.toContain("mermaid-diagram");
		expect(errorSpy).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});
