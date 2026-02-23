import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
	it('shows "未保存" when saveStatus is unsaved', () => {
		render(<StatusBar saveStatus="unsaved" />);
		expect(screen.getByText("未保存")).toBeInTheDocument();
	});

	it('shows "保存中..." when saveStatus is saving', () => {
		render(<StatusBar saveStatus="saving" />);
		expect(screen.getByText("保存中...")).toBeInTheDocument();
	});

	it('shows "保存済み" when saveStatus is saved', () => {
		render(<StatusBar saveStatus="saved" />);
		expect(screen.getByText("保存済み")).toBeInTheDocument();
	});

	it('shows "保存失敗" when saveStatus is error', () => {
		render(<StatusBar saveStatus="error" />);
		expect(screen.getByText("保存失敗")).toBeInTheDocument();
	});

	it("shows no status text when saveStatus is not provided", () => {
		render(<StatusBar />);
		expect(screen.queryByText("保存済み")).not.toBeInTheDocument();
		expect(screen.queryByText("未保存")).not.toBeInTheDocument();
		expect(screen.queryByText("保存中...")).not.toBeInTheDocument();
		expect(screen.queryByText("保存失敗")).not.toBeInTheDocument();
	});

	it("shows cursor info when provided", () => {
		render(<StatusBar cursorInfo={{ line: 10, col: 5, chars: 1234 }} />);
		expect(screen.getByText("10 行, 5 列")).toBeInTheDocument();
		expect(screen.getByText("1234 文字")).toBeInTheDocument();
	});

	it("does not show cursor info when not provided", () => {
		render(<StatusBar saveStatus="saved" />);
		expect(screen.queryByText(/\d+ 行,/)).not.toBeInTheDocument();
		expect(screen.queryByText(/文字/)).not.toBeInTheDocument();
	});

	it("shows file path when provided", () => {
		render(<StatusBar filePath="docs/readme.md" />);
		expect(screen.getByTestId("file-path")).toHaveTextContent("docs/readme.md");
	});

	it("copies file path to clipboard on click", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.assign(navigator, { clipboard: { writeText } });

		render(<StatusBar filePath="docs/readme.md" />);
		await userEvent.click(screen.getByTestId("file-path"));

		expect(writeText).toHaveBeenCalledWith("docs/readme.md");
	});

	it("does not throw when clipboard is unavailable", async () => {
		const original = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

		render(<StatusBar filePath="docs/readme.md" />);
		await userEvent.click(screen.getByTestId("file-path"));
		// Should not throw

		Object.defineProperty(navigator, "clipboard", { value: original, configurable: true });
	});

	it("shows selection info when selectedChars and selectedLines are present", () => {
		render(
			<StatusBar
				cursorInfo={{ line: 3, col: 1, chars: 500, selectedChars: 42, selectedLines: 3 }}
			/>,
		);
		expect(screen.getByTestId("selection-info")).toHaveTextContent("3 行選択, 42 文字選択");
		expect(screen.queryByText(/\d+ 行,/)).not.toBeInTheDocument();
	});

	it("shows cursor position when no selection", () => {
		render(<StatusBar cursorInfo={{ line: 5, col: 10, chars: 200 }} />);
		expect(screen.getByText("5 行, 10 列")).toBeInTheDocument();
		expect(screen.queryByTestId("selection-info")).not.toBeInTheDocument();
	});
});
