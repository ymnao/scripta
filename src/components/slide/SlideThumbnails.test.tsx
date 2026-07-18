import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("mermaid", () => ({
	default: {
		initialize: vi.fn(),
		render: vi.fn().mockResolvedValue({ svg: "<svg></svg>" }),
		parse: vi.fn().mockResolvedValue(true),
	},
}));

import type { SlideSection } from "../../types/slide";
import { SlideThumbnails } from "./SlideThumbnails";

const SLIDES: SlideSection[] = [
	{ content: "# A", from: 0, to: 5 },
	{ content: "# B", from: 6, to: 11 },
	{ content: "# C", from: 12, to: 17 },
];

describe("SlideThumbnails", () => {
	it("スライド数と同じボタンをレンダリングする", () => {
		render(<SlideThumbnails slides={SLIDES} currentSlideIndex={0} onSelectSlide={vi.fn()} />);
		expect(screen.getAllByRole("button")).toHaveLength(3);
	});

	it("current index のボタンに aria-current='true' が付く", () => {
		render(<SlideThumbnails slides={SLIDES} currentSlideIndex={1} onSelectSlide={vi.fn()} />);
		const buttons = screen.getAllByRole("button");
		expect(buttons[0].getAttribute("aria-current")).toBeNull();
		expect(buttons[1].getAttribute("aria-current")).toBe("true");
		expect(buttons[2].getAttribute("aria-current")).toBeNull();
	});

	it("クリックで onSelectSlide が index つきで呼ばれる", () => {
		const onSelectSlide = vi.fn();
		render(<SlideThumbnails slides={SLIDES} currentSlideIndex={0} onSelectSlide={onSelectSlide} />);
		fireEvent.click(screen.getAllByRole("button")[2]);
		expect(onSelectSlide).toHaveBeenCalledWith(2);
	});

	it("各サムネイルに 1-based の番号が表示される", () => {
		render(<SlideThumbnails slides={SLIDES} currentSlideIndex={0} onSelectSlide={vi.fn()} />);
		expect(screen.getByText("1")).toBeDefined();
		expect(screen.getByText("2")).toBeDefined();
		expect(screen.getByText("3")).toBeDefined();
	});

	// auto-scroll の delta 計算 / axis / behavior 挙動は useScrollActiveChildIntoView の
	// hook test 側で網羅しているため、ここでは thin integration として「currentSlideIndex
	// 変化で nav の scrollBy が呼ばれる (= hook が発火経路に繋がっている)」だけ検証する。
	it("currentSlideIndex 変化で nav の scrollBy が発火する (hook 統合)", () => {
		const { rerender } = render(
			<SlideThumbnails slides={SLIDES} currentSlideIndex={0} onSelectSlide={vi.fn()} />,
		);
		const nav = screen.getByTestId("slide-thumbnails");
		nav.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
		screen.getAllByRole("button").forEach((b, i) => {
			b.getBoundingClientRect = () => new DOMRect(i * 120, 0, 120, 100);
		});
		const scrollBy = vi.fn();
		(nav as unknown as { scrollBy: (arg: ScrollToOptions) => void }).scrollBy = scrollBy;

		rerender(<SlideThumbnails slides={SLIDES} currentSlideIndex={2} onSelectSlide={vi.fn()} />);

		expect(scrollBy).toHaveBeenCalledWith({ left: 60, behavior: "smooth" });
	});
});
