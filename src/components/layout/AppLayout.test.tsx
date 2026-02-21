import { act, render, screen } from "@testing-library/react";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "../../lib/commands";
import { useWorkspaceStore } from "../../stores/workspace";
import type { FsChangeEvent } from "../../types/workspace";

vi.mock("../../lib/commands", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	listDirectory: vi.fn().mockResolvedValue([]),
	startWatcher: vi.fn().mockResolvedValue(undefined),
	stopWatcher: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));

// Capture the fs-change listener callback so tests can emit events
type FsChangeCallback = (event: { payload: FsChangeEvent[] }) => void;
let fsChangeCallback: FsChangeCallback | null = null;

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockImplementation((_name: string, cb: FsChangeCallback) => {
		fsChangeCallback = cb;
		return Promise.resolve(() => {
			fsChangeCallback = null;
		});
	}),
}));

function emitFsChange(events: FsChangeEvent[]) {
	if (fsChangeCallback) {
		fsChangeCallback({ payload: events });
	}
}

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

function openFileInStore(workspacePath: string, filePath: string) {
	useWorkspaceStore.setState({
		workspacePath,
		tabs: [{ path: filePath, dirty: false }],
		activeTabPath: filePath,
	});
}

describe("AppLayout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		fsChangeCallback = null;
		mockedReadFile.mockResolvedValue("# Hello");
		mockedWriteFile.mockResolvedValue(undefined);
		useWorkspaceStore.setState({
			workspacePath: null,
			tabs: [],
			activeTabPath: null,
		});
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

	it("loads file content when activeTabPath is set", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});
		expect(mockedReadFile).toHaveBeenCalledWith("/workspace/test.md");
		expect(screen.getByTestId("editor-value")).toHaveTextContent("# Hello");
	});

	it('shows "Saved" after loading file', async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});
		expect(screen.getByText("Saved")).toBeInTheDocument();
	});

	it('shows "Unsaved" when content changes', async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(screen.getByText("Unsaved")).toBeInTheDocument();
	});

	it("auto-saves after debounce period", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
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
		openFileInStore("/workspace", "/workspace/test.md");
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

	it("saves previous file to correct path when switching tabs", async () => {
		openFileInStore("/workspace", "/workspace/a.md");
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

		// Switch to file B by adding tab and activating it
		mockedReadFile.mockResolvedValue("content B");
		await act(async () => {
			useWorkspaceStore.setState({
				tabs: [
					{ path: "/workspace/a.md", dirty: true },
					{ path: "/workspace/b.md", dirty: false },
				],
				activeTabPath: "/workspace/b.md",
			});
		});

		// Should have saved "new content" to a.md (NOT b.md)
		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/a.md", "new content");
		expect(mockedWriteFile).not.toHaveBeenCalledWith("/workspace/b.md", "new content");

		// Should load file B
		expect(mockedReadFile).toHaveBeenCalledWith("/workspace/b.md");

		unmount();
	});

	it("does not auto-save empty content when readFile fails", async () => {
		openFileInStore("/workspace", "/workspace/broken.md");
		mockedReadFile.mockRejectedValue(new Error("file not found"));

		await act(async () => {
			render(<AppLayout />);
		});

		expect(screen.getByTestId("editor-value")).toHaveTextContent("");
		expect(screen.getByText("Saved")).toBeInTheDocument();

		mockedWriteFile.mockClear();

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it('shows "Save failed" on save error', async () => {
		openFileInStore("/workspace", "/workspace/test.md");
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

	it("restores cached content when switching back to a tab", async () => {
		openFileInStore("/workspace", "/workspace/a.md");
		mockedReadFile.mockResolvedValue("content A");

		await act(async () => {
			render(<AppLayout />);
		});
		expect(screen.getByTestId("editor-value")).toHaveTextContent("content A");

		// Edit file A
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});

		// Switch to file B
		mockedReadFile.mockResolvedValue("content B");
		await act(async () => {
			useWorkspaceStore.setState({
				tabs: [
					{ path: "/workspace/a.md", dirty: true },
					{ path: "/workspace/b.md", dirty: false },
				],
				activeTabPath: "/workspace/b.md",
			});
		});
		expect(screen.getByTestId("editor-value")).toHaveTextContent("content B");

		// Switch back to A — should restore edited content from cache
		mockedReadFile.mockClear();
		await act(async () => {
			useWorkspaceStore.setState({ activeTabPath: "/workspace/a.md" });
		});
		expect(screen.getByTestId("editor-value")).toHaveTextContent("new content");
		// Should NOT re-read from disk
		expect(mockedReadFile).not.toHaveBeenCalled();
	});

	it("syncs dirty flag to store", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		expect(useWorkspaceStore.getState().tabs[0].dirty).toBe(false);

		await act(async () => {
			screen.getByTestId("editor-change").click();
		});

		expect(useWorkspaceStore.getState().tabs[0].dirty).toBe(true);
	});

	it("does not close active tab when save on close fails", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		// Edit file
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(screen.getByText("Unsaved")).toBeInTheDocument();

		// Make writeFile fail
		mockedWriteFile.mockRejectedValue(new Error("disk full"));

		// Try to close via Cmd+W
		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true }),
			);
		});

		// Tab should still be open
		expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
		expect(useWorkspaceStore.getState().activeTabPath).toBe("/workspace/test.md");
		// Editor content should be preserved
		expect(screen.getByTestId("editor-value")).toHaveTextContent("new content");
	});

	it("does not close non-active tab when save on close fails", async () => {
		// Open two tabs: a.md (active) and b.md
		useWorkspaceStore.setState({
			workspacePath: "/workspace",
			tabs: [
				{ path: "/workspace/a.md", dirty: false },
				{ path: "/workspace/b.md", dirty: true },
			],
			activeTabPath: "/workspace/a.md",
		});
		mockedReadFile.mockResolvedValue("content A");

		await act(async () => {
			render(<AppLayout />);
		});

		// Switch to b.md so it gets cached, then switch back to a.md
		mockedReadFile.mockResolvedValue("content B");
		await act(async () => {
			useWorkspaceStore.setState({ activeTabPath: "/workspace/b.md" });
		});
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		mockedReadFile.mockResolvedValue("content A");
		await act(async () => {
			useWorkspaceStore.setState({ activeTabPath: "/workspace/a.md" });
		});

		// Now b.md has dirty content in cache. Make writeFile fail.
		mockedWriteFile.mockRejectedValue(new Error("disk full"));

		// Try to close b.md (non-active tab) via the close button
		const closeButton = screen.getByLabelText("Close b.md");
		await act(async () => {
			closeButton.click();
		});

		// b.md should still be in the tab list
		expect(useWorkspaceStore.getState().tabs).toHaveLength(2);
		expect(useWorkspaceStore.getState().tabs.map((t) => t.path)).toEqual([
			"/workspace/a.md",
			"/workspace/b.md",
		]);
	});

	it("saves unsaved content when Cmd+W fires immediately after edit", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		// Edit and immediately Cmd+W in the same act — saveStatus has not yet
		// flipped to "unsaved", but contentRef !== savedContentRef detects the diff.
		await act(async () => {
			screen.getByTestId("editor-change").click();
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true }),
			);
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/test.md", "new content");
		expect(useWorkspaceStore.getState().tabs).toEqual([]);
	});

	it("closes active tab on Cmd+W", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "w", metaKey: true, bubbles: true }),
			);
		});

		expect(useWorkspaceStore.getState().tabs).toEqual([]);
		expect(useWorkspaceStore.getState().activeTabPath).toBeNull();
	});

	it("shows conflict dialog when dirty active tab is externally modified", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		// Make the tab dirty
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(useWorkspaceStore.getState().tabs[0].dirty).toBe(true);

		// Emit external modify event and flush the 300ms batch timer
		await act(async () => {
			emitFsChange([{ kind: "modify", path: "/workspace/test.md" }]);
			vi.advanceTimersByTime(300);
		});

		expect(screen.getByText("File changed externally")).toBeInTheDocument();
		expect(screen.queryByText("File deleted externally")).not.toBeInTheDocument();
	});

	it("shows deleted dialog when dirty tab is externally deleted", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		// Make the tab dirty
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});

		// Emit external delete event and flush
		await act(async () => {
			emitFsChange([{ kind: "delete", path: "/workspace/test.md" }]);
			vi.advanceTimersByTime(300);
		});

		expect(screen.getByText("File deleted externally")).toBeInTheDocument();
		expect(screen.queryByText("File changed externally")).not.toBeInTheDocument();
	});

	it("deleted dialog supersedes conflict dialog for the same file", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		// Make the tab dirty
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});

		// First: external modify → conflict dialog
		await act(async () => {
			emitFsChange([{ kind: "modify", path: "/workspace/test.md" }]);
			vi.advanceTimersByTime(300);
		});
		expect(screen.getByText("File changed externally")).toBeInTheDocument();

		// Then: external delete → should replace with deleted dialog
		await act(async () => {
			emitFsChange([{ kind: "delete", path: "/workspace/test.md" }]);
			vi.advanceTimersByTime(300);
		});

		expect(screen.getByText("File deleted externally")).toBeInTheDocument();
		expect(screen.queryByText("File changed externally")).not.toBeInTheDocument();
	});

	it("only shows one dialog when different files trigger conflicts", async () => {
		// Open a.md as active tab
		openFileInStore("/workspace", "/workspace/a.md");
		await act(async () => {
			render(<AppLayout />);
		});

		// Make a.md dirty
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(useWorkspaceStore.getState().tabs[0].dirty).toBe(true);

		// External modify on a.md (active, dirty) → conflict dialog
		await act(async () => {
			emitFsChange([{ kind: "modify", path: "/workspace/a.md" }]);
			vi.advanceTimersByTime(300);
		});
		expect(screen.getByText("File changed externally")).toBeInTheDocument();

		// Add b.md as a second dirty tab (non-active)
		await act(async () => {
			useWorkspaceStore.setState({
				tabs: [
					{ path: "/workspace/a.md", dirty: true },
					{ path: "/workspace/b.md", dirty: true },
				],
			});
		});

		// External delete on b.md (non-active, dirty) → replaces with deleted dialog
		await act(async () => {
			emitFsChange([{ kind: "delete", path: "/workspace/b.md" }]);
			vi.advanceTimersByTime(300);
		});
		expect(screen.getByText("File deleted externally")).toBeInTheDocument();
		expect(screen.queryByText("File changed externally")).not.toBeInTheDocument();
	});

	it("conflict reload updates only target tab when active tab changed", async () => {
		openFileInStore("/workspace", "/workspace/a.md");
		mockedReadFile.mockResolvedValue("content A");
		await act(async () => {
			render(<AppLayout />);
		});

		// Make a.md dirty
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});

		// Trigger conflict dialog for a.md
		await act(async () => {
			emitFsChange([{ kind: "modify", path: "/workspace/a.md" }]);
			vi.advanceTimersByTime(300);
		});
		expect(screen.getByText("File changed externally")).toBeInTheDocument();

		// Switch to b.md while dialog is still open
		mockedReadFile.mockResolvedValue("content B");
		await act(async () => {
			useWorkspaceStore.setState({
				tabs: [
					{ path: "/workspace/a.md", dirty: true },
					{ path: "/workspace/b.md", dirty: false },
				],
				activeTabPath: "/workspace/b.md",
			});
		});
		expect(screen.getByTestId("editor-value")).toHaveTextContent("content B");

		// Click "Reload" on the conflict dialog
		mockedReadFile.mockResolvedValue("reloaded A");
		await act(async () => {
			screen.getByRole("button", { name: "Reload" }).click();
		});

		// Editor should still show b.md content, NOT the reloaded a.md content
		expect(screen.getByTestId("editor-value")).toHaveTextContent("content B");

		// a.md's dirty flag should be cleared after reload
		const aTab = useWorkspaceStore.getState().tabs.find((tab) => tab.path === "/workspace/a.md");
		expect(aTab?.dirty).toBe(false);
	});
});
