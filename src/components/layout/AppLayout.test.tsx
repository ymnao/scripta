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
		mockedWriteFile.mockResolvedValue(undefined);
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

	it('shows "Saved" after loading file', async () => {
		await act(async () => {
			render(<AppLayout />);
		});
		expect(screen.getByText("Saved")).toBeInTheDocument();
	});

	it('shows "Unsaved" when content changes', async () => {
		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(screen.getByText("Unsaved")).toBeInTheDocument();
	});

	it("auto-saves after debounce period", async () => {
		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(screen.getByText("Unsaved")).toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("../test-files/test.md", "new content");
		expect(screen.getByText("Saved")).toBeInTheDocument();
	});

	it("saves immediately on Cmd+S (saveNow)", async () => {
		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(screen.getByText("Unsaved")).toBeInTheDocument();

		await act(async () => {
			screen.getByTestId("editor-save").click();
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("../test-files/test.md", "new content");
		expect(screen.getByText("Saved")).toBeInTheDocument();
	});

	it('shows "Save failed" on save error', async () => {
		mockedWriteFile.mockRejectedValue(new Error("write error"));

		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			screen.getByTestId("editor-change").click();
		});

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});

		expect(screen.getByText("Save failed")).toBeInTheDocument();
	});
});
