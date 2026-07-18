import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactElement, useRef } from "react";
import { describe, expect, it } from "vitest";
import { useFocusTrap } from "./useFocusTrap";

function Harness({
	enabled = true,
	includeDisabled = false,
}: {
	enabled?: boolean;
	includeDisabled?: boolean;
}): ReactElement {
	const ref = useRef<HTMLDivElement>(null);
	useFocusTrap(ref, enabled);
	return (
		<div>
			<button type="button" data-testid="outside-before">
				outside-before
			</button>
			<div ref={ref} data-testid="container">
				<button type="button" data-testid="first">
					first
				</button>
				{includeDisabled && (
					<button type="button" disabled data-testid="disabled">
						disabled
					</button>
				)}
				<button type="button" data-testid="middle">
					middle
				</button>
				<button type="button" data-testid="last">
					last
				</button>
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

	it("disabled button は focusable として数えない (last は最終有効 button)", async () => {
		const user = userEvent.setup();
		render(<Harness includeDisabled />);
		screen.getByTestId("last").focus();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByTestId("first"));
	});

	it("enabled=false なら trap しない (last の Tab は container 外へ抜ける)", async () => {
		const user = userEvent.setup();
		render(<Harness enabled={false} />);
		screen.getByTestId("last").focus();
		await user.tab();
		expect(document.activeElement).toBe(screen.getByTestId("outside-after"));
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
