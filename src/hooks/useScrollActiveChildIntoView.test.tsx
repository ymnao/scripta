import { render, screen } from "@testing-library/react";
import { type ReactElement, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useScrollActiveChildIntoView } from "./useScrollActiveChildIntoView";

function Harness({
	activeIndex,
	axis,
	behavior,
}: {
	activeIndex: number;
	axis?: "x" | "y";
	behavior?: ScrollBehavior;
}): ReactElement {
	const ref = useRef<HTMLDivElement>(null);
	useScrollActiveChildIntoView(ref, activeIndex, { axis, behavior });
	return (
		<div ref={ref} data-testid="container">
			<div>A</div>
			<div>B</div>
			<div>C</div>
		</div>
	);
}

function stubRects(
	container: HTMLElement,
	containerRect: DOMRect,
	childRects: DOMRect[],
): { scrollBy: ReturnType<typeof vi.fn> } {
	container.getBoundingClientRect = () => containerRect;
	Array.from(container.children).forEach((child, i) => {
		(child as HTMLElement).getBoundingClientRect = () => childRects[i];
	});
	const scrollBy = vi.fn();
	(container as unknown as { scrollBy: (arg: ScrollToOptions) => void }).scrollBy = scrollBy;
	return { scrollBy };
}

describe("useScrollActiveChildIntoView", () => {
	it("y 軸: 子が下側にはみ出している時 scrollBy(top=delta) が呼ばれる", () => {
		const { rerender } = render(<Harness activeIndex={0} />);
		const { scrollBy } = stubRects(screen.getByTestId("container"), new DOMRect(0, 0, 200, 100), [
			new DOMRect(0, 0, 200, 40),
			new DOMRect(0, 40, 200, 40),
			new DOMRect(0, 80, 200, 40), // bottom 120 > container bottom 100 → delta=20
		]);
		rerender(<Harness activeIndex={2} />);
		expect(scrollBy).toHaveBeenCalledWith({ top: 20, behavior: "auto" });
	});

	it("y 軸: 子が上側にはみ出している時 scrollBy(top=負) が呼ばれる", () => {
		const { rerender } = render(<Harness activeIndex={2} />);
		const { scrollBy } = stubRects(
			screen.getByTestId("container"),
			new DOMRect(0, 50, 200, 100), // container 表示範囲 [50, 150]
			[
				new DOMRect(0, 0, 200, 40), // top 0 < container top 50 → delta=-50
				new DOMRect(0, 60, 200, 40),
				new DOMRect(0, 110, 200, 40),
			],
		);
		rerender(<Harness activeIndex={0} />);
		expect(scrollBy).toHaveBeenCalledWith({ top: -50, behavior: "auto" });
	});

	it("x 軸: 子が右にはみ出している時 scrollBy(left=delta) が呼ばれる", () => {
		const { rerender } = render(<Harness activeIndex={0} axis="x" />);
		const { scrollBy } = stubRects(screen.getByTestId("container"), new DOMRect(0, 0, 300, 100), [
			new DOMRect(0, 0, 120, 100),
			new DOMRect(120, 0, 120, 100),
			new DOMRect(240, 0, 120, 100), // right 360 > 300 → delta=60
		]);
		rerender(<Harness activeIndex={2} axis="x" />);
		expect(scrollBy).toHaveBeenCalledWith({ left: 60, behavior: "auto" });
	});

	it("x 軸: 子が左にはみ出している時 scrollBy(left=負) が呼ばれる", () => {
		const { rerender } = render(<Harness activeIndex={2} axis="x" />);
		const { scrollBy } = stubRects(
			screen.getByTestId("container"),
			new DOMRect(150, 0, 300, 100), // container 表示範囲 [150, 450]
			[
				new DOMRect(0, 0, 120, 100), // left 0 < container left 150 → delta=-150
				new DOMRect(200, 0, 120, 100),
				new DOMRect(400, 0, 120, 100),
			],
		);
		rerender(<Harness activeIndex={0} axis="x" />);
		expect(scrollBy).toHaveBeenCalledWith({ left: -150, behavior: "auto" });
	});

	it("既に可視範囲内なら scrollBy を呼ばない (delta=0 short-circuit)", () => {
		const { rerender } = render(<Harness activeIndex={0} />);
		const { scrollBy } = stubRects(screen.getByTestId("container"), new DOMRect(0, 0, 200, 200), [
			new DOMRect(0, 0, 200, 40),
			new DOMRect(0, 40, 200, 40),
			new DOMRect(0, 80, 200, 40),
		]);
		rerender(<Harness activeIndex={1} />);
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("containerRef が要素に接続されていない時 (mount 前) は例外を投げず no-op", () => {
		// React 契約上 useEffect は ref populated 後に走るので実運用で trigger 困難だが、
		// 防御的 early return (`if (!container || !child) return`) がテスト対象外にならないよう
		// ref を DOM に接続しない Harness で走行させ、例外や scrollBy 呼び出しが無いことを確認。
		function DetachedHarness({ activeIndex }: { activeIndex: number }): ReactElement {
			const ref = useRef<HTMLDivElement>(null);
			useScrollActiveChildIntoView(ref, activeIndex);
			return <div>no-ref</div>;
		}
		expect(() => render(<DetachedHarness activeIndex={0} />)).not.toThrow();
	});

	it("activeIndex が children.length を超える時は no-op", () => {
		const { rerender } = render(<Harness activeIndex={0} />);
		const { scrollBy } = stubRects(screen.getByTestId("container"), new DOMRect(0, 0, 200, 100), [
			new DOMRect(0, 0, 200, 40),
			new DOMRect(0, 40, 200, 40),
			new DOMRect(0, 80, 200, 40),
		]);
		rerender(<Harness activeIndex={99} />);
		expect(scrollBy).not.toHaveBeenCalled();
	});

	it("初回 mount 時に activeIndex が範囲外なら scrollBy が呼ばれる", () => {
		// 既存テストは render → stub rects → rerender の 2 段で index 変化経路を検証していたため、
		// activeIndex ≠ 0 で mount された時の initial-mount scroll (SlideThumbnails で最後に開いた
		// slide index が復元される等) が未検証。prototype patch で rects と scrollBy を render 前に
		// 注入する。`Object.defineProperty` を使うのは、DOM `scrollBy` の overload 定義 (options
		// 単数 or x/y 2 引数) を function 直代入で満たすと strict mode で this の暗黙 any + 引数数
		// 不一致になるため、value descriptor で型検査を迂回する (テスト内のみの stub なので安全)。
		const originalGetRect = HTMLElement.prototype.getBoundingClientRect;
		const originalScrollBy = HTMLElement.prototype.scrollBy;
		const scrollBy = vi.fn();
		HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
			if (this.getAttribute("data-testid") === "container") {
				return new DOMRect(0, 0, 200, 100);
			}
			if (
				this.tagName === "DIV" &&
				this.parentElement?.getAttribute("data-testid") === "container"
			) {
				const idx = Array.from(this.parentElement.children).indexOf(this);
				return new DOMRect(0, idx * 40, 200, 40);
			}
			return originalGetRect.call(this);
		};
		Object.defineProperty(HTMLElement.prototype, "scrollBy", {
			configurable: true,
			writable: true,
			value(this: HTMLElement, ...args: unknown[]): void {
				if (this.getAttribute("data-testid") === "container") {
					scrollBy(args[0]);
				} else {
					(originalScrollBy as (...a: unknown[]) => void).apply(this, args);
				}
			},
		});

		try {
			render(<Harness activeIndex={2} />);
			// index=2 の子は [80, 120]、container 表示 [0, 100] で bottom はみ出し → delta=20
			expect(scrollBy).toHaveBeenCalledWith({ top: 20, behavior: "auto" });
		} finally {
			HTMLElement.prototype.getBoundingClientRect = originalGetRect;
			Object.defineProperty(HTMLElement.prototype, "scrollBy", {
				configurable: true,
				writable: true,
				value: originalScrollBy,
			});
		}
	});

	it("behavior='smooth' を指定するとその値で scrollBy が呼ばれる", () => {
		const { rerender } = render(<Harness activeIndex={0} behavior="smooth" />);
		const { scrollBy } = stubRects(screen.getByTestId("container"), new DOMRect(0, 0, 200, 100), [
			new DOMRect(0, 0, 200, 40),
			new DOMRect(0, 40, 200, 40),
			new DOMRect(0, 80, 200, 40),
		]);
		rerender(<Harness activeIndex={2} behavior="smooth" />);
		expect(scrollBy).toHaveBeenCalledWith({ top: 20, behavior: "smooth" });
	});
});
