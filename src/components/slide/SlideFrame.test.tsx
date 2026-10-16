import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSlideContentOverflowing, SLIDE_OVERFLOW_MESSAGE, SlideFrame } from "./SlideStage";

// jsdom には layout が無いので、本文要素の寸法を prototype の getter で与える。
function stubContentSize({
	height,
	scrollWidth = 1152,
	clientWidth = 1152,
}: {
	height: number;
	scrollWidth?: number;
	clientWidth?: number;
}) {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(height);
	vi.spyOn(Element.prototype, "scrollWidth", "get").mockReturnValue(scrollWidth);
	vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(clientWidth);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("isSlideContentOverflowing", () => {
	const el = () => document.createElement("div");

	it("高さが本文領域 (720 - 64 * 2 = 592px) ちょうどなら収まっている", () => {
		stubContentSize({ height: 592 });
		expect(isSlideContentOverflowing(el())).toBe(false);
	});

	it("高さが 593px ならはみ出している", () => {
		stubContentSize({ height: 593 });
		expect(isSlideContentOverflowing(el())).toBe(true);
	});

	it("横幅が本文領域を超えたらはみ出している", () => {
		stubContentSize({ height: 100, scrollWidth: 1153, clientWidth: 1152 });
		expect(isSlideContentOverflowing(el())).toBe(true);
	});

	it("横幅が本文領域ちょうどなら収まっている", () => {
		stubContentSize({ height: 100, scrollWidth: 1152, clientWidth: 1152 });
		expect(isSlideContentOverflowing(el())).toBe(false);
	});
});

describe("SlideFrame のはみ出しの印", () => {
	it("overflowIndicator を指定しないと、はみ出していても印を出さない", () => {
		stubContentSize({ height: 1000 });
		render(<SlideFrame scale={1} html="<p>x</p>" />);
		expect(screen.queryByTestId("slide-overflow-bar")).toBeNull();
	});

	it("badge は帯と文言のバッジを出し、読み上げ用の文言に id を付ける", () => {
		stubContentSize({ height: 1000 });
		render(
			<SlideFrame scale={1} html="<p>x</p>" overflowIndicator="badge" overflowIndicatorId="o1" />,
		);
		expect(screen.getByTestId("slide-overflow-bar")).toBeDefined();
		expect(screen.getByText("収まっていません")).toBeDefined();
		expect(document.getElementById("o1")?.textContent).toBe(SLIDE_OVERFLOW_MESSAGE);
	});

	it("bar は帯だけを出す", () => {
		stubContentSize({ height: 1000 });
		render(<SlideFrame scale={1} html="<p>x</p>" overflowIndicator="bar" />);
		expect(screen.getByTestId("slide-overflow-bar")).toBeDefined();
		expect(screen.queryByText("収まっていません")).toBeNull();
	});

	it("収まっていれば印を出さない", () => {
		stubContentSize({ height: 592 });
		render(<SlideFrame scale={1} html="<p>x</p>" overflowIndicator="badge" />);
		expect(screen.queryByTestId("slide-overflow-bar")).toBeNull();
	});

	it("空のスライドには印を出さない", () => {
		stubContentSize({ height: 1000 });
		render(<SlideFrame scale={1} html="" overflowIndicator="badge" />);
		expect(screen.queryByTestId("slide-overflow-bar")).toBeNull();
	});

	it("html が差し替わったら測り直す", () => {
		stubContentSize({ height: 100 });
		const { rerender } = render(<SlideFrame scale={1} html="<p>a</p>" overflowIndicator="badge" />);
		expect(screen.queryByTestId("slide-overflow-bar")).toBeNull();
		stubContentSize({ height: 1000 });
		rerender(<SlideFrame scale={1} html="<p>b</p>" overflowIndicator="badge" />);
		expect(screen.getByTestId("slide-overflow-bar")).toBeDefined();
	});

	it("html が同じでも、本文要素のサイズが変わったら (ResizeObserver) 測り直す", () => {
		const callbacks: ResizeObserverCallback[] = [];
		const observed: Element[] = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(cb: ResizeObserverCallback) {
					callbacks.push(cb);
				}
				observe(target: Element) {
					observed.push(target);
				}
				unobserve() {}
				disconnect() {}
			},
		);
		stubContentSize({ height: 100 });
		render(<SlideFrame scale={1} html="<p>a</p>" overflowIndicator="badge" />);
		expect(observed).toEqual([document.querySelector(".slide-preview-content")]);
		expect(screen.queryByTestId("slide-overflow-bar")).toBeNull();

		stubContentSize({ height: 1000 });
		act(() => {
			for (const cb of callbacks) cb([], {} as ResizeObserver);
		});
		expect(screen.getByTestId("slide-overflow-bar")).toBeDefined();
	});
});
