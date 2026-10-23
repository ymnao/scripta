import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IME_COMPOSING } from "../../__test-utils__/ime";
import { DialogBase } from "./DialogBase";

function renderDialog() {
	const onClose = vi.fn();
	render(
		<DialogBase open onClose={onClose}>
			<input aria-label="名前" />
		</DialogBase>,
	);
	return { onClose, input: screen.getByLabelText("名前") };
}

describe("Esc", () => {
	it("入力欄の Esc で閉じる", () => {
		const { onClose, input } = renderDialog();

		fireEvent.keyDown(input, { key: "Escape" });

		expect(onClose).toHaveBeenCalledOnce();
	});

	it.each(IME_COMPOSING)("IME 変換中（$how）の入力欄の Esc では閉じない", ({ init }) => {
		const { onClose, input } = renderDialog();

		fireEvent.keyDown(input, { key: "Escape", ...init });

		expect(onClose).not.toHaveBeenCalled();
	});
});
