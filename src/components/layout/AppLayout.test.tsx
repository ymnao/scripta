import { act, render, screen } from "@testing-library/react";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "../../lib/commands";

vi.mock("../../lib/commands", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
}));

vi.mock("../editor/MarkdownEditor", () => ({
	MarkdownEditor: ({
		value,
		onChange,
		onSave,
	}: { value: string; onChange: (v: string) => void; onSave: () => void }) => (
		<div data-testid="mock-editor">
			<span data-testid="editor-value">{value}</span>
			<button type="button" data-testid="editor-change" onClick={() => onChange("new content")}>
				change
			</button>
			<button type="button" data-testid="editor-save" onClick={onSave}>
				save
			</button>
		</div>
	),
}));

const { AppLayout } = await import("./AppLayout");

const mockedReadFile = readFile as Mock;
const mockedWriteFile = writeFile as Mock;

describe("AppLayout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockedReadFile.mockResolvedValue("# Hello");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("loads file content on mount", async () => {
		await act(async () => {
			render(<AppLayout />);
		});
		expect(mockedReadFile).toHaveBeenCalledWith("../test-files/test.md");
		expect(screen.getByTestId("editor-value")).toHaveTextContent("# Hello");
	});

	it('shows "Saving..." then "Saved" on successful save', async () => {
		let resolveWrite!: () => void;
		mockedWriteFile.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveWrite = resolve;
			}),
		);

		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			screen.getByTestId("editor-save").click();
		});
		expect(screen.getByText("Saving...")).toBeInTheDocument();

		await act(async () => {
			resolveWrite();
		});
		expect(screen.getByText("Saved")).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(screen.queryByText("Saved")).not.toBeInTheDocument();
	});

	it('shows "Save failed" on save error', async () => {
		let rejectWrite!: (reason: Error) => void;
		mockedWriteFile.mockReturnValue(
			new Promise<void>((_resolve, reject) => {
				rejectWrite = reject;
			}),
		);

		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			screen.getByTestId("editor-save").click();
		});
		expect(screen.getByText("Saving...")).toBeInTheDocument();

		await act(async () => {
			rejectWrite(new Error("write error"));
		});
		expect(screen.getByText("Save failed")).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(3000);
		});
		expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
	});
});
