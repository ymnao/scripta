import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../stores/settings", () => ({
	useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({
			showLineNumbers: false,
			fontSize: 14,
			fontFamily: "monospace",
			highlightActiveLine: false,
			showLinkCards: false,
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
	it("エディタとプレビューの両方をレンダリングする", () => {
		render(<SlideView value={"# Slide 1\n---\n# Slide 2"} onChange={vi.fn()} onSave={vi.fn()} />);
		// エディタが存在する
		expect(screen.getByRole("textbox")).toBeDefined();
		// プレビューのスライド番号が表示される
		expect(screen.getByText("1 / 2")).toBeDefined();
	});

	it("スライド番号が正しく表示される", () => {
		render(<SlideView value={"A\n---\nB\n---\nC"} onChange={vi.fn()} onSave={vi.fn()} />);
		// 初期カーソル位置は0なので最初のスライド
		expect(screen.getByText("1 / 3")).toBeDefined();
	});

	it("区切りなしのドキュメントは1枚のスライド", () => {
		render(<SlideView value="# Single Slide" onChange={vi.fn()} onSave={vi.fn()} />);
		expect(screen.getByText("1 / 1")).toBeDefined();
	});

	it("onEditorView コールバックが呼ばれる", () => {
		const onEditorView = vi.fn();
		render(
			<SlideView value="test" onChange={vi.fn()} onSave={vi.fn()} onEditorView={onEditorView} />,
		);
		// MarkdownEditor が EditorView を生成したタイミングでコールバックが呼ばれる
		expect(onEditorView).toHaveBeenCalled();
	});

	it("onStatistics コールバックが呼ばれる", async () => {
		const onStatistics = vi.fn();
		render(
			<SlideView value="test" onChange={vi.fn()} onSave={vi.fn()} onStatistics={onStatistics} />,
		);
		// MarkdownEditor の onCreateEditor で初回の statistics が発火する
		// requestAnimationFrame のタイミングで呼ばれるため await が必要
		await act(async () => {
			await new Promise((r) => setTimeout(r, 50));
		});
		expect(onStatistics).toHaveBeenCalled();
	});
});
