import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactElement, useRef } from "react";
import { describe, expect, it } from "vitest";
import { useFocusTrap } from "./useFocusTrap";

function Harness({
	enabled = true,
	includeDisabledAtEnd = false,
	includeNegativeTabindex = false,
	empty = false,
}: {
	enabled?: boolean;
	includeDisabledAtEnd?: boolean;
	includeNegativeTabindex?: boolean;
	empty?: boolean;
}): ReactElement {
	const ref = useRef<HTMLDivElement>(null);
	useFocusTrap(ref, enabled);
	return (
		<div>
			<button type="button" data-testid="outside-before">
				outside-before
			</button>
			<div ref={ref} tabIndex={-1} data-testid="container">
				{!empty && (
					<>
						<button type="button" data-testid="first">
							first
						</button>
						<button type="button" data-testid="middle">
							middle
						</button>
						<button type="button" data-testid="last">
							last
						</button>
						{includeDisabledAtEnd && (
							<button type="button" disabled data-testid="disabled-tail">
								disabled-tail
							</button>
						)}
						{includeNegativeTabindex && (
							<button type="button" tabIndex={-2} data-testid="neg-tabindex-tail">
								neg-tabindex-tail
							</button>
						)}
					</>
				)}
			</div>
			<button type="button" data-testid="outside-after">
				outside-after
			</button>
		</div>
	);
}

describe("useFocusTrap", () => {
	it("last で Tab を押すと first に折り返す", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		screen.getByTestId("last").focus();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByTestId("first"));
	});

	it("first で Shift+Tab を押すと last に折り返す", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		screen.getByTestId("first").focus();
		await user.tab({ shift: true });
		expect(document.activeElement).toBe(screen.getByTestId("last"));
	});

	it("中間で Tab を押すと通常通り次に進む (trap しない)", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		screen.getByTestId("first").focus();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByTestId("middle"));
	});

	it("disabled button が末尾にあっても last は最終有効 button (selector で除外)", async () => {
		const user = userEvent.setup();
		render(<Harness includeDisabledAtEnd />);
		screen.getByTestId("last").focus();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByTestId("first"));
	});

	it("tabIndex=-2 の要素は末尾でも last と見なさない (getFocusables で除外)", async () => {
		const user = userEvent.setup();
		render(<Harness includeNegativeTabindex />);
		screen.getByTestId("last").focus();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByTestId("first"));
	});

	it("container 外に focus がある時 Tab を押すと first に吸い込む", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		screen.getByTestId("outside-before").focus();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByTestId("first"));
	});

	it("container 外に focus がある時 Shift+Tab を押すと last に吸い込む", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		screen.getByTestId("outside-after").focus();
		await user.tab({ shift: true });
		expect(document.activeElement).toBe(screen.getByTestId("last"));
	});

	it("container 自身 (tabIndex=-1) に focus がある状態で Shift+Tab を押すと last に吸い込む", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		screen.getByTestId("container").focus();
		await user.tab({ shift: true });
		expect(document.activeElement).toBe(screen.getByTestId("last"));
	});

	it("focusable が 0 件でも Tab を preventDefault して modal 外へ抜けない", async () => {
		const user = userEvent.setup();
		render(<Harness empty />);
		screen.getByTestId("outside-before").focus();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByTestId("outside-before"));
	});

	it("enabled=false なら trap しない (last の Tab は container 外へ抜ける)", async () => {
		const user = userEvent.setup();
		render(<Harness enabled={false} />);
		screen.getByTestId("last").focus();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByTestId("outside-after"));
	});

	it("enabled を true→false→true と切り替えても listener は正しく貼り直される", async () => {
		const user = userEvent.setup();
		const { rerender } = render(<Harness enabled={true} />);
		rerender(<Harness enabled={false} />);
		screen.getByTestId("last").focus();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByTestId("outside-after"));
		rerender(<Harness enabled={true} />);
		screen.getByTestId("last").focus();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByTestId("first"));
	});

	it("container ref が null の間は no-op (throw しない)", () => {
		function NullHarness(): ReactElement {
			const ref = useRef<HTMLDivElement>(null);
			useFocusTrap(ref);
			return <div>no container</div>;
		}
		expect(() => render(<NullHarness />)).not.toThrow();
	});
});
