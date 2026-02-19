import { act, render, screen } from "@testing-library/react";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "../../lib/commands";
import { useWorkspaceStore } from "../../stores/workspace";

vi.mock("../../lib/commands", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	listDirectory: vi.fn().mockResolvedValue([]),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
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

function setWorkspaceState(workspacePath: string | null, openFilePath: string | null) {
	useWorkspaceStore.setState({ workspacePath, openFilePath });
}

describe("AppLayout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockedReadFile.mockResolvedValue("# Hello");
		mockedWriteFile.mockResolvedValue(undefined);
		useWorkspaceStore.setState({ workspacePath: null, openFilePath: null });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("shows empty state when no file is open", async () => {
		await act(async () => {
			render(<AppLayout />);
		});
		expect(screen.getByText("Select a file to start editing")).toBeInTheDocument();
		expect(screen.queryByTestId("mock-editor")).not.toBeInTheDocument();
	});

	it("loads file content when openFilePath is set", async () => {
		setWorkspaceState("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});
		expect(mockedReadFile).toHaveBeenCalledWith("/workspace/test.md");
		expect(screen.getByTestId("editor-value")).toHaveTextContent("# Hello");
	});

	it('shows "Saved" after loading file', async () => {
		setWorkspaceState("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});
		expect(screen.getByText("Saved")).toBeInTheDocument();
	});

	it('shows "Unsaved" when content changes', async () => {
		setWorkspaceState("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(screen.getByText("Unsaved")).toBeInTheDocument();
	});

	it("auto-saves after debounce period", async () => {
		setWorkspaceState("/workspace", "/workspace/test.md");
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

		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/test.md", "new content");
		expect(screen.getByText("Saved")).toBeInTheDocument();
	});

	it("saves immediately on Cmd+S (saveNow)", async () => {
		setWorkspaceState("/workspace", "/workspace/test.md");
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

		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/test.md", "new content");
		expect(screen.getByText("Saved")).toBeInTheDocument();
	});

	it("saves previous file to correct path when switching files", async () => {
		setWorkspaceState("/workspace", "/workspace/a.md");
		mockedReadFile.mockResolvedValue("content A");

		const { unmount } = await act(async () => {
			return render(<AppLayout />);
		});
		expect(screen.getByTestId("editor-value")).toHaveTextContent("content A");

		// Edit file A
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(screen.getByText("Unsaved")).toBeInTheDocument();

		// Switch to file B
		mockedReadFile.mockResolvedValue("content B");
		await act(async () => {
			useWorkspaceStore.setState({ openFilePath: "/workspace/b.md" });
		});

		// Should have saved "new content" to a.md (NOT b.md)
		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/a.md", "new content");
		expect(mockedWriteFile).not.toHaveBeenCalledWith("/workspace/b.md", "new content");

		// Should load file B
		expect(mockedReadFile).toHaveBeenCalledWith("/workspace/b.md");

		unmount();
	});

	it("does not auto-save empty content when readFile fails", async () => {
		setWorkspaceState("/workspace", "/workspace/broken.md");
		mockedReadFile.mockRejectedValue(new Error("file not found"));

		await act(async () => {
			render(<AppLayout />);
		});

		// Content is empty, status should be saved (markSaved("") called)
		expect(screen.getByTestId("editor-value")).toHaveTextContent("");
		expect(screen.getByText("Saved")).toBeInTheDocument();

		mockedWriteFile.mockClear();

		// Advance past debounce — should NOT attempt to write empty content
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it('shows "Save failed" on save error', async () => {
		setWorkspaceState("/workspace", "/workspace/test.md");
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
