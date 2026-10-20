import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GoToLineDialog } from "./GoToLineDialog";

// isIMEComposing は isComposing と keyCode 229 のどちらかで変換中とみなすので、片方ずつ撃つ
const IME = [
	{ how: "keyCode 229", init: { keyCode: 229 } },
	{ how: "isComposing", init: { isComposing: true } },
];

function renderDialog() {
	const onClose = vi.fn();
	render(<GoToLineDialog open totalLines={10} onGoToLine={vi.fn()} onClose={onClose} />);
	return { onClose, input: screen.getByLabelText("行番号:") };
}

describe("Esc", () => {
	it("入力欄の Esc で閉じる", () => {
		const { onClose, input } = renderDialog();

		fireEvent.keyDown(input, { key: "Escape" });

		expect(onClose).toHaveBeenCalledOnce();
	});

	it.each(IME)("IME 変換中（$how）の入力欄の Esc では閉じない", ({ init }) => {
		const { onClose, input } = renderDialog();

		fireEvent.keyDown(input, { key: "Escape", ...init });

		expect(onClose).not.toHaveBeenCalled();
	});
});
