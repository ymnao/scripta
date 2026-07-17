import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
	afterEach(() => {
		vi.restoreAllMocks();
		delete (HTMLElement.prototype as unknown as { scrollBy?: unknown }).scrollBy;
	});

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
		const scrollBy = vi.fn();
		const navRect = { left: 0, right: 300, top: 0, bottom: 100, width: 300, height: 100 };
		const rectAt = (i: number) => ({
			left: i * 120,
			right: (i + 1) * 120,
			top: 0,
			bottom: 100,
			width: 120,
			height: 100,
		});
		const origGBCR = Element.prototype.getBoundingClientRect;
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
			this: Element,
		) {
			if (this.tagName === "NAV") return navRect as DOMRect;
			const btns = Array.from((this.ownerDocument as Document).querySelectorAll("button"));
			const i = btns.indexOf(this as HTMLButtonElement);
			if (i >= 0) return rectAt(i) as DOMRect;
			return origGBCR.call(this);
		});
		(HTMLElement.prototype as unknown as { scrollBy: (arg: ScrollToOptions) => void }).scrollBy =
			scrollBy;

		render(<SlideThumbnails slides={SLIDES} currentSlideIndex={2} onSelectSlide={vi.fn()} />);

		expect(scrollBy).toHaveBeenCalledWith({ left: 60, behavior: "smooth" });
	});
});
