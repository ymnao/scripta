import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmojiInputDialog } from "./EmojiInputDialog";

const defaultProps = {
	open: true,
	currentEmoji: null,
	entryName: "test-file.md",
	onConfirm: vi.fn(),
	onRemove: vi.fn(),
	onCancel: vi.fn(),
};

function renderDialog(overrides: Partial<typeof defaultProps> = {}) {
	const props = { ...defaultProps, ...overrides };
	// Reset mocks each render
	for (const fn of [props.onConfirm, props.onRemove, props.onCancel]) {
		if (vi.isMockFunction(fn)) fn.mockClear();
	}
	return render(<EmojiInputDialog {...props} />);
}

describe("EmojiInputDialog", () => {
	it("open=false で非表示", () => {
		renderDialog({ open: false });
		expect(screen.queryByLabelText("絵文字を入力")).not.toBeInTheDocument();
	});

	it("open=true で表示される", () => {
		renderDialog({ open: true });
		expect(screen.getByLabelText("絵文字を入力")).toBeInTheDocument();
	});

	it("currentEmoji の初期値が input に反映される", () => {
		renderDialog({ currentEmoji: "🎉" });
		expect(screen.getByLabelText("絵文字を入力")).toHaveValue("🎉");
	});

	it("currentEmoji=null で空文字が初期値", () => {
		renderDialog({ currentEmoji: null });
		expect(screen.getByLabelText("絵文字を入力")).toHaveValue("");
	});

	it("entryName が表示される", () => {
		renderDialog({ entryName: "my-note.md" });
		expect(screen.getByText("my-note.md")).toBeInTheDocument();
	});

	it("入力して「設定」→ onConfirm(trimmed) が呼ばれる", async () => {
		const onConfirm = vi.fn();
		renderDialog({ onConfirm });
		const input = screen.getByLabelText("絵文字を入力");
		await userEvent.type(input, " 🔥 ");
		await userEvent.click(screen.getByText("設定"));
		expect(onConfirm).toHaveBeenCalledWith("🔥");
	});

	it("Enter キーで onConfirm が呼ばれる", async () => {
		const onConfirm = vi.fn();
		renderDialog({ onConfirm });
		const input = screen.getByLabelText("絵文字を入力");
		await userEvent.type(input, "✅");
		await userEvent.keyboard("{Enter}");
		expect(onConfirm).toHaveBeenCalledWith("✅");
	});

	it("空入力で「設定」ボタンが disabled", () => {
		renderDialog({ currentEmoji: null });
		expect(screen.getByText("設定")).toBeDisabled();
	});

	it("空入力で Enter しても onConfirm が呼ばれない", async () => {
		const onConfirm = vi.fn();
		renderDialog({ onConfirm, currentEmoji: null });
		const input = screen.getByLabelText("絵文字を入力");
		input.focus();
		await userEvent.keyboard("{Enter}");
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("「キャンセル」→ onCancel が呼ばれる", async () => {
		const onCancel = vi.fn();
		renderDialog({ onCancel });
		await userEvent.click(screen.getByText("キャンセル"));
		expect(onCancel).toHaveBeenCalled();
	});

	it("currentEmoji ありで「削除」ボタン表示、クリックで onRemove", async () => {
		const onRemove = vi.fn();
		renderDialog({ currentEmoji: "📝", onRemove });
		const deleteBtn = screen.getByText("削除");
		expect(deleteBtn).toBeInTheDocument();
		await userEvent.click(deleteBtn);
		expect(onRemove).toHaveBeenCalled();
	});

	it("currentEmoji=null で「削除」ボタン非表示", () => {
		renderDialog({ currentEmoji: null });
		expect(screen.queryByText("削除")).not.toBeInTheDocument();
	});
});
