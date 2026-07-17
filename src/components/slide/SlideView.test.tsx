import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setSlidePreviewWidthRatio = vi.fn();
const setSlideThumbnailsVisible = vi.fn();
let mockSlidePreviewWidthRatio = 0.45;
let mockSlideThumbnailsVisible = true;

vi.mock("../../stores/settings", () => ({
	useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({
			showLineNumbers: false,
			fontSize: 14,
			fontFamily: "monospace",
			highlightActiveLine: false,
			showLinkCards: false,
			slidePreviewWidthRatio: mockSlidePreviewWidthRatio,
			setSlidePreviewWidthRatio,
			slideThumbnailsVisible: mockSlideThumbnailsVisible,
			setSlideThumbnailsVisible,
		}),
}));

vi.mock("mermaid", () => ({
	default: {
		initialize: vi.fn(),
		render: vi.fn().mockResolvedValue({ svg: "<svg></svg>" }),
		parse: vi.fn().mockResolvedValue(true),
	},
}));

import { SlideView } from "./SlideView";

describe("SlideView", () => {
	beforeEach(() => {
		mockSlidePreviewWidthRatio = 0.45;
		mockSlideThumbnailsVisible = true;
		setSlidePreviewWidthRatio.mockClear();
		setSlideThumbnailsVisible.mockClear();
	});

	// SlidePreview は #301 で React.lazy 化されたため、初回描画は Suspense fallback
	// (null) になる。動的 import の解決を待つには findByText（非同期）を使う。
	it("エディタとプレビューの両方をレンダリングする", async () => {
		render(
			<SlideView value={"# Slide 1\n---\n# Slide 2"} onDocChanged={vi.fn()} onSave={vi.fn()} />,
		);
		// エディタが存在する
		expect(screen.getByRole("textbox")).toBeDefined();
		// プレビューのスライド番号が表示される
		expect(await screen.findByText("1 / 2")).toBeDefined();
	});

	it("スライド番号が正しく表示される", async () => {
		render(<SlideView value={"A\n---\nB\n---\nC"} onDocChanged={vi.fn()} onSave={vi.fn()} />);
		// 初期カーソル位置は0なので最初のスライド
		expect(await screen.findByText("1 / 3")).toBeDefined();
	});

	it("区切りなしのドキュメントは1枚のスライド", async () => {
		render(<SlideView value="# Single Slide" onDocChanged={vi.fn()} onSave={vi.fn()} />);
		expect(await screen.findByText("1 / 1")).toBeDefined();
	});

	it("1 枚だけならサムネイル一覧を出さない", async () => {
		render(<SlideView value="# Only" onDocChanged={vi.fn()} onSave={vi.fn()} />);
		await screen.findByText("1 / 1");
		expect(screen.queryByTestId("slide-thumbnails")).toBeNull();
	});

	it("複数スライドでサムネイル一覧を表示する", async () => {
		mockSlideThumbnailsVisible = true;
		render(<SlideView value={"A\n---\nB\n---\nC"} onDocChanged={vi.fn()} onSave={vi.fn()} />);
		await screen.findByText("1 / 3");
		expect(screen.getByTestId("slide-thumbnails")).toBeDefined();
	});

	it("slideThumbnailsVisible=false ならサムネイル本体は非表示 (toggle ボタンは残る)", async () => {
		mockSlideThumbnailsVisible = false;
		render(<SlideView value={"A\n---\nB\n---\nC"} onDocChanged={vi.fn()} onSave={vi.fn()} />);
		await screen.findByText("1 / 3");
		expect(screen.queryByTestId("slide-thumbnails")).toBeNull();
		expect(screen.getByTestId("slide-thumbnails-toggle")).toBeDefined();
	});

	it("toggle ボタン click で setSlideThumbnailsVisible を反転して呼ぶ", async () => {
		mockSlideThumbnailsVisible = true;
		setSlideThumbnailsVisible.mockClear();
		render(<SlideView value={"A\n---\nB\n---\nC"} onDocChanged={vi.fn()} onSave={vi.fn()} />);
		await screen.findByText("1 / 3");
		fireEvent.click(screen.getByTestId("slide-thumbnails-toggle"));
		expect(setSlideThumbnailsVisible).toHaveBeenCalledWith(false);
	});

	it("onEditorView コールバックが呼ばれる", () => {
		const onEditorView = vi.fn();
		render(
			<SlideView
				value="test"
				onDocChanged={vi.fn()}
				onSave={vi.fn()}
				onEditorView={onEditorView}
			/>,
		);
		// MarkdownEditor が EditorView を生成したタイミングでコールバックが呼ばれる
		expect(onEditorView).toHaveBeenCalled();
	});

	describe("プレビュー幅リサイズ (Fable #13)", () => {
		it("リサイズハンドルがレンダリングされ、store 値を width に反映する", () => {
			mockSlidePreviewWidthRatio = 0.45;
			const { container } = render(
				<SlideView value="# Slide" onDocChanged={vi.fn()} onSave={vi.fn()} />,
			);
			const handle = screen.getByTestId("slide-preview-resize-handle");
			expect(handle).toBeDefined();
			expect(handle.getAttribute("aria-valuenow")).toBe("45");
			const previewPane = container.querySelector<HTMLDivElement>('[style*="width"]');
			expect(previewPane).not.toBeNull();
			// jsdom normalizes "45.0000%" → "45%"; check both parse to the same value.
			expect(previewPane?.style.width && parseFloat(previewPane.style.width)).toBe(45);
		});

		it("ArrowLeft で preview が広がる (ARIA splitter 規約と drag 方向に一致)", () => {
			mockSlidePreviewWidthRatio = 0.45;
			setSlidePreviewWidthRatio.mockClear();
			render(<SlideView value="# Slide" onDocChanged={vi.fn()} onSave={vi.fn()} />);
			const handle = screen.getByTestId("slide-preview-resize-handle");
			fireEvent.keyDown(handle, { key: "ArrowLeft" });
			expect(setSlidePreviewWidthRatio).toHaveBeenCalledWith(expect.closeTo(0.47, 5));
		});

		it("ArrowRight で preview が縮む", () => {
			mockSlidePreviewWidthRatio = 0.45;
			setSlidePreviewWidthRatio.mockClear();
			render(<SlideView value="# Slide" onDocChanged={vi.fn()} onSave={vi.fn()} />);
			const handle = screen.getByTestId("slide-preview-resize-handle");
			fireEvent.keyDown(handle, { key: "ArrowRight" });
			expect(setSlidePreviewWidthRatio).toHaveBeenCalledWith(expect.closeTo(0.43, 5));
		});

		it("Home / End キーで editor を min / max に (preview は max / min に)", () => {
			mockSlidePreviewWidthRatio = 0.45;
			setSlidePreviewWidthRatio.mockClear();
			render(<SlideView value="# Slide" onDocChanged={vi.fn()} onSave={vi.fn()} />);
			const handle = screen.getByTestId("slide-preview-resize-handle");
			// Home: editor min = preview MAX ratio
			fireEvent.keyDown(handle, { key: "Home" });
			expect(setSlidePreviewWidthRatio).toHaveBeenCalledWith(0.7);
			// End: editor max = preview MIN ratio
			fireEvent.keyDown(handle, { key: "End" });
			expect(setSlidePreviewWidthRatio).toHaveBeenCalledWith(0.2);
		});

		it("pointercancel は draft を破棄して setSlidePreviewWidthRatio を呼ばない (A2)", () => {
			// OS/ブラウザによる gesture 中断 (touch → scroll escalation, window blur, system
			// modal 等) は「ユーザーの意図的な release」ではないため commit しない。
			mockSlidePreviewWidthRatio = 0.45;
			setSlidePreviewWidthRatio.mockClear();
			render(<SlideView value="# Slide" onDocChanged={vi.fn()} onSave={vi.fn()} />);
			const handle = screen.getByTestId("slide-preview-resize-handle");
			// pointerdown → pointermove → pointercancel の一連。pointercancel は
			// pointerup とは別 handler なので commit されない。
			fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
			// pointermove / pointercancel は React 合成でなく listener 登録経由
			// (addEventListener) なので dispatchEvent で発火する。
			handle.dispatchEvent(
				new PointerEvent("pointermove", { clientX: 100, bubbles: true, pointerId: 1 }),
			);
			handle.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 1 }));
			expect(setSlidePreviewWidthRatio).not.toHaveBeenCalled();
		});

		it("min / max を超える ArrowLeft/Right はクランプされる", () => {
			mockSlidePreviewWidthRatio = 0.7;
			setSlidePreviewWidthRatio.mockClear();
			const { rerender } = render(
				<SlideView value="# Slide" onDocChanged={vi.fn()} onSave={vi.fn()} />,
			);
			const handle = screen.getByTestId("slide-preview-resize-handle");
			// 0.7 で ArrowLeft (拡大方向) を押しても MAX (0.7) で頭打ち
			fireEvent.keyDown(handle, { key: "ArrowLeft" });
			expect(setSlidePreviewWidthRatio).toHaveBeenLastCalledWith(0.7);

			mockSlidePreviewWidthRatio = 0.2;
			rerender(<SlideView value="# Slide" onDocChanged={vi.fn()} onSave={vi.fn()} />);
			// 0.2 で ArrowRight (縮小方向) を押しても MIN (0.2) で頭打ち
			fireEvent.keyDown(handle, { key: "ArrowRight" });
			expect(setSlidePreviewWidthRatio).toHaveBeenLastCalledWith(0.2);
		});
	});

	it("onStatistics コールバックが呼ばれる", async () => {
		const onStatistics = vi.fn();
		render(
			<SlideView
				value="test"
				onDocChanged={vi.fn()}
				onSave={vi.fn()}
				onStatistics={onStatistics}
			/>,
		);
		// MarkdownEditor の onCreateEditor で初回の statistics が発火する
		// requestAnimationFrame のタイミングで呼ばれるため await が必要
		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});
		expect(onStatistics).toHaveBeenCalled();
	});
});
