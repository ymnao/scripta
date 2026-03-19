import { render, screen, within } from "@testing-library/react";
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
	for (const fn of [props.onConfirm, props.onRemove, props.onCancel]) {
		if (vi.isMockFunction(fn)) fn.mockClear();
	}
	return render(<EmojiInputDialog {...props} />);
}

describe("EmojiInputDialog", () => {
	it("open=false で非表示", () => {
		renderDialog({ open: false });
		expect(screen.queryByText("アイコンを設定")).not.toBeInTheDocument();
	});

	it("open=true で表示される", () => {
		renderDialog({ open: true });
		expect(screen.getByText("アイコンを設定")).toBeInTheDocument();
	});

	it("entryName が表示される", () => {
		renderDialog({ entryName: "my-note.md" });
		expect(screen.getByText("my-note.md")).toBeInTheDocument();
	});

	it("絵文字グリッドが表示される", () => {
		renderDialog();
		const grid = screen.getByLabelText("絵文字一覧");
		expect(grid).toBeInTheDocument();
		expect(within(grid).getAllByRole("button").length).toBeGreaterThan(0);
	});

	it("カテゴリタブが表示される", () => {
		renderDialog();
		expect(screen.getByLabelText("スマイリー")).toBeInTheDocument();
		expect(screen.getByLabelText("オブジェクト")).toBeInTheDocument();
		expect(screen.getByLabelText("記号")).toBeInTheDocument();
	});

	it("全カテゴリの絵文字が一覧に表示される", () => {
		renderDialog();
		const grid = screen.getByLabelText("絵文字一覧");

		// スマイリーとオブジェクトの絵文字が両方表示される
		expect(within(grid).getByLabelText("😀")).toBeInTheDocument();
		expect(within(grid).getByLabelText("💡")).toBeInTheDocument();
	});

	it("カテゴリ見出しが表示される", () => {
		renderDialog();
		const grid = screen.getByLabelText("絵文字一覧");
		expect(within(grid).getByText("スマイリー")).toBeInTheDocument();
		expect(within(grid).getByText("オブジェクト")).toBeInTheDocument();
	});

	it("絵文字をクリックして「設定」→ onConfirm が呼ばれる", async () => {
		const onConfirm = vi.fn();
		renderDialog({ onConfirm });

		const grid = screen.getByLabelText("絵文字一覧");
		await userEvent.click(within(grid).getByLabelText("😀"));
		await userEvent.click(screen.getByText("設定"));
		expect(onConfirm).toHaveBeenCalledWith("😀");
	});

	it("絵文字未選択で「設定」ボタンが disabled", () => {
		renderDialog({ currentEmoji: null });
		expect(screen.getByText("設定")).toBeDisabled();
	});

	it("currentEmoji がプレビューに反映される", () => {
		renderDialog({ currentEmoji: "🎉" });
		const preview = screen.getByLabelText("選択中の絵文字");
		expect(preview).toHaveTextContent("🎉");
	});

	it("currentEmoji がグリッド内でハイライトされる", () => {
		renderDialog({ currentEmoji: "😀" });
		const grid = screen.getByLabelText("絵文字一覧");
		const emojiBtn = within(grid).getByLabelText("😀");
		expect(emojiBtn.className).toContain("bg-black/10");
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
