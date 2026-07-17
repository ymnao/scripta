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

	it("current thumbnail が右側に切れている時 nav.scrollBy で追随する", () => {
		// nav: [0, 300], thumbnails: 各 120 幅で 0-based に配置。
		// index=2 は [240, 360] で右端 360 が nav.right=300 を超える → scrollBy(60) 期待。
		const rect = (left: number, right: number) =>
			({ left, right, top: 0, bottom: 100, width: right - left, height: 100 }) as DOMRect;

		const { rerender } = render(
			<SlideThumbnails slides={SLIDES} currentSlideIndex={0} onSelectSlide={vi.fn()} />,
		);
		const nav = screen.getByTestId("slide-thumbnails");
		const buttons = screen.getAllByRole("button");
		nav.getBoundingClientRect = () => rect(0, 300);
		buttons.forEach((b, i) => {
			b.getBoundingClientRect = () => rect(i * 120, (i + 1) * 120);
		});
		const scrollBy = vi.fn();
		(nav as unknown as { scrollBy: (arg: ScrollToOptions) => void }).scrollBy = scrollBy;

		rerender(<SlideThumbnails slides={SLIDES} currentSlideIndex={2} onSelectSlide={vi.fn()} />);

		expect(scrollBy).toHaveBeenCalledWith({ left: 60, behavior: "smooth" });
	});
});
