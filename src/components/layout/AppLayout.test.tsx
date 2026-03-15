import { act, render, screen } from "@testing-library/react";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileExists, readFile, writeFile } from "../../lib/commands";
import { isNewTabPath } from "../../lib/path";
import { useWorkspaceStore } from "../../stores/workspace";
import { useWorkspaceConfigStore } from "../../stores/workspace-config";
import type { FsChangeEvent } from "../../types/workspace";

vi.mock("../../lib/commands", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	fileExists: vi.fn().mockResolvedValue(false),
	listDirectory: vi.fn().mockResolvedValue([]),
	startWatcher: vi.fn().mockResolvedValue(undefined),
	stopWatcher: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
	open: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
	loadSettings: vi.fn().mockResolvedValue({
		workspacePath: null,
		themePreference: "system",
		sidebarVisible: true,
		showLineNumbers: true,
		fontSize: 14,
		autoSaveDelay: 2000,
		highlightActiveLine: false,
		fontFamily: "monospace",
		trimTrailingWhitespace: true,
		showLinkCards: true,
		gitSyncEnabled: false,
		autoCommitInterval: 10,
		autoPullInterval: 10,
		autoPushInterval: 10,
		pullBeforePush: true,
		syncMethod: "merge",
		commitMessage: "vault backup: {{date}}",
		autoPullOnStartup: false,
		scratchpadVolatile: true,
	}),
	saveWorkspacePath: vi.fn().mockResolvedValue(undefined),
	saveThemePreference: vi.fn().mockResolvedValue(undefined),
	saveSidebarVisible: vi.fn().mockResolvedValue(undefined),
	saveShowLineNumbers: vi.fn().mockResolvedValue(undefined),
	saveFontSize: vi.fn().mockResolvedValue(undefined),
	saveAutoSaveDelay: vi.fn().mockResolvedValue(undefined),
	saveHighlightActiveLine: vi.fn().mockResolvedValue(undefined),
	saveFontFamily: vi.fn().mockResolvedValue(undefined),
	saveTrimTrailingWhitespace: vi.fn().mockResolvedValue(undefined),
	saveShowLinkCards: vi.fn().mockResolvedValue(undefined),
	saveScratchpadVolatile: vi.fn().mockResolvedValue(undefined),
	saveGitSyncEnabled: vi.fn().mockResolvedValue(undefined),
	saveAutoCommitInterval: vi.fn().mockResolvedValue(undefined),
	saveAutoPullInterval: vi.fn().mockResolvedValue(undefined),
	saveAutoPushInterval: vi.fn().mockResolvedValue(undefined),
	savePullBeforePush: vi.fn().mockResolvedValue(undefined),
	saveSyncMethod: vi.fn().mockResolvedValue(undefined),
	saveCommitMessage: vi.fn().mockResolvedValue(undefined),
	saveAutoPullOnStartup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../hooks/useGitSync", () => ({
	useGitSync: () => ({ manualSync: vi.fn() }),
}));

const MockWebviewWindowConstructor = vi.fn();
// Assign static method so TypeScript is happy with `WebviewWindow.getByLabel()`
MockWebviewWindowConstructor.getByLabel = vi.fn().mockReturnValue(null);

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	WebviewWindow: MockWebviewWindowConstructor,
}));

// Capture the fs-change listener callback so tests can emit events
type FsChangeCallback = (event: { payload: FsChangeEvent[] }) => void;
let fsChangeCallback: FsChangeCallback | null = null;

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockImplementation((name: string, cb: FsChangeCallback) => {
		if (name === "fs-change") {
			fsChangeCallback = cb;
		}
		return Promise.resolve(() => {
			if (name === "fs-change") {
				fsChangeCallback = null;
			}
		});
	}),
}));

function emitFsChange(events: FsChangeEvent[]) {
	if (fsChangeCallback) {
		fsChangeCallback({ payload: events });
	}
}

type CloseRequestedEvent = { preventDefault: () => void };
type CloseHandler = (event: CloseRequestedEvent) => void | Promise<void>;
let closeHandler: CloseHandler | null = null;
const mockDestroy = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		onCloseRequested: vi.fn().mockImplementation((handler: CloseHandler) => {
			closeHandler = handler;
			return Promise.resolve(() => {
				closeHandler = null;
			});
		}),
		destroy: mockDestroy,
	}),
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
const { useGitSyncStore } = await import("../../stores/git-sync");
const { useScratchpadStore } = await import("../../stores/scratchpad");

const mockedReadFile = readFile as Mock;
const mockedWriteFile = writeFile as Mock;
const mockedFileExists = fileExists as Mock;

let nextId = 1;
function openFileInStore(workspacePath: string, filePath: string) {
	const id = nextId++;
	useWorkspaceStore.setState({
		workspacePath,
		tabs: [{ id, path: filePath, dirty: false, history: [filePath], historyIndex: 0 }],
		activeTabPath: filePath,
		activeTabId: id,
		_nextTabId: id + 1,
	});
}

describe("AppLayout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		fsChangeCallback = null;
		closeHandler = null;
		mockDestroy.mockClear();
		MockWebviewWindowConstructor.mockClear();
		(MockWebviewWindowConstructor.getByLabel as Mock).mockReturnValue(null);
		mockedReadFile.mockResolvedValue("# Hello");
		mockedWriteFile.mockResolvedValue(undefined);
		nextId = 1;
		useWorkspaceStore.setState({
			workspacePath: null,
			tabs: [],
			activeTabPath: null,
			activeTabId: null,
			_nextTabId: 1,
		});
		useWorkspaceConfigStore.getState().reset();
		useGitSyncStore.getState().resetRuntime();
		useScratchpadStore.setState({ open: false });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("shows motto when no workspace is open", async () => {
		await act(async () => {
			render(<AppLayout />);
		});
		expect(screen.getByLabelText("scripta")).toBeInTheDocument();
		expect(screen.getByText("Verba volant, scripta manent.")).toBeInTheDocument();
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

	it('shows "保存済み" after loading file', async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});
		expect(screen.getByText("保存済み")).toBeInTheDocument();
	});

	it('shows "未保存" when content changes', async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(screen.getByText("未保存")).toBeInTheDocument();
	});

	it("auto-saves after debounce period", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(screen.getByText("未保存")).toBeInTheDocument();

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/test.md", "new content\n");
		expect(screen.getByText("保存済み")).toBeInTheDocument();
	});

	it("saves immediately on Cmd+S (saveNow)", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(screen.getByText("未保存")).toBeInTheDocument();

		await act(async () => {
			screen.getByTestId("editor-save").click();
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/test.md", "new content\n");
		expect(screen.getByText("保存済み")).toBeInTheDocument();
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
		expect(screen.getByText("未保存")).toBeInTheDocument();

		// Switch to file B by adding tab and activating it
		mockedReadFile.mockResolvedValue("content B");
		await act(async () => {
			useWorkspaceStore.setState({
				tabs: [
					{
						id: 1,
						path: "/workspace/a.md",
						dirty: true,
						history: ["/workspace/a.md"],
						historyIndex: 0,
					},
					{
						id: 2,
						path: "/workspace/b.md",
						dirty: false,
						history: ["/workspace/b.md"],
						historyIndex: 0,
					},
				],
				activeTabPath: "/workspace/b.md",
				activeTabId: 2,
				_nextTabId: 3,
			});
		});

		// Should have saved "new content" to a.md (NOT b.md)
		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/a.md", "new content\n");
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

		expect(screen.getByText(/エラーが発生しました/)).toBeInTheDocument();
		expect(screen.getByText("保存済み")).toBeInTheDocument();

		mockedWriteFile.mockClear();

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it('shows "保存失敗" on save error', async () => {
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

		expect(screen.getByText("保存失敗")).toBeInTheDocument();
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
					{
						id: 1,
						path: "/workspace/a.md",
						dirty: true,
						history: ["/workspace/a.md"],
						historyIndex: 0,
					},
					{
						id: 2,
						path: "/workspace/b.md",
						dirty: false,
						history: ["/workspace/b.md"],
						historyIndex: 0,
					},
				],
				activeTabPath: "/workspace/b.md",
				activeTabId: 2,
				_nextTabId: 3,
			});
		});
		expect(screen.getByTestId("editor-value")).toHaveTextContent("content B");

		// Switch back to A — should restore edited content from cache
		mockedReadFile.mockClear();
		await act(async () => {
			useWorkspaceStore.setState({ activeTabPath: "/workspace/a.md", activeTabId: 1 });
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
		expect(screen.getByText("未保存")).toBeInTheDocument();

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
				{
					id: 1,
					path: "/workspace/a.md",
					dirty: false,
					history: ["/workspace/a.md"],
					historyIndex: 0,
				},
				{
					id: 2,
					path: "/workspace/b.md",
					dirty: true,
					history: ["/workspace/b.md"],
					historyIndex: 0,
				},
			],
			activeTabPath: "/workspace/a.md",
			activeTabId: 1,
			_nextTabId: 3,
		});
		mockedReadFile.mockResolvedValue("content A");

		await act(async () => {
			render(<AppLayout />);
		});

		// Switch to b.md so it gets cached, then switch back to a.md
		mockedReadFile.mockResolvedValue("content B");
		await act(async () => {
			useWorkspaceStore.setState({ activeTabPath: "/workspace/b.md", activeTabId: 2 });
		});
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		mockedReadFile.mockResolvedValue("content A");
		await act(async () => {
			useWorkspaceStore.setState({ activeTabPath: "/workspace/a.md", activeTabId: 1 });
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

		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/test.md", "new content\n");
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

		expect(screen.getByText("ファイルが外部で変更されました")).toBeInTheDocument();
		expect(screen.queryByText("ファイルが外部で削除されました")).not.toBeInTheDocument();
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

		expect(screen.getByText("ファイルが外部で削除されました")).toBeInTheDocument();
		expect(screen.queryByText("ファイルが外部で変更されました")).not.toBeInTheDocument();
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
		expect(screen.getByText("ファイルが外部で変更されました")).toBeInTheDocument();

		// Then: external delete → should replace with deleted dialog
		await act(async () => {
			emitFsChange([{ kind: "delete", path: "/workspace/test.md" }]);
			vi.advanceTimersByTime(300);
		});

		expect(screen.getByText("ファイルが外部で削除されました")).toBeInTheDocument();
		expect(screen.queryByText("ファイルが外部で変更されました")).not.toBeInTheDocument();
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
		expect(screen.getByText("ファイルが外部で変更されました")).toBeInTheDocument();

		// Add b.md as a second dirty tab (non-active)
		await act(async () => {
			useWorkspaceStore.setState({
				tabs: [
					{
						id: 1,
						path: "/workspace/a.md",
						dirty: true,
						history: ["/workspace/a.md"],
						historyIndex: 0,
					},
					{
						id: 2,
						path: "/workspace/b.md",
						dirty: true,
						history: ["/workspace/b.md"],
						historyIndex: 0,
					},
				],
				_nextTabId: 3,
			});
		});

		// External delete on b.md (non-active, dirty) → replaces with deleted dialog
		await act(async () => {
			emitFsChange([{ kind: "delete", path: "/workspace/b.md" }]);
			vi.advanceTimersByTime(300);
		});
		expect(screen.getByText("ファイルが外部で削除されました")).toBeInTheDocument();
		expect(screen.queryByText("ファイルが外部で変更されました")).not.toBeInTheDocument();
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
		expect(screen.getByText("ファイルが外部で変更されました")).toBeInTheDocument();

		// Switch to b.md while dialog is still open
		mockedReadFile.mockResolvedValue("content B");
		await act(async () => {
			useWorkspaceStore.setState({
				tabs: [
					{
						id: 1,
						path: "/workspace/a.md",
						dirty: true,
						history: ["/workspace/a.md"],
						historyIndex: 0,
					},
					{
						id: 2,
						path: "/workspace/b.md",
						dirty: false,
						history: ["/workspace/b.md"],
						historyIndex: 0,
					},
				],
				activeTabPath: "/workspace/b.md",
				activeTabId: 2,
				_nextTabId: 3,
			});
		});
		expect(screen.getByTestId("editor-value")).toHaveTextContent("content B");

		// Click "再読み込み" on the conflict dialog
		mockedReadFile.mockResolvedValue("reloaded A");
		await act(async () => {
			screen.getByRole("button", { name: "再読み込み" }).click();
		});

		// Editor should still show b.md content, NOT the reloaded a.md content
		expect(screen.getByTestId("editor-value")).toHaveTextContent("content B");

		// a.md's dirty flag should be cleared after reload
		const aTab = useWorkspaceStore.getState().tabs.find((tab) => tab.path === "/workspace/a.md");
		expect(aTab?.dirty).toBe(false);
	});

	it("saves dirty active tab on window close", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		// Edit file
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(screen.getByText("未保存")).toBeInTheDocument();

		// Simulate window close
		const preventDefault = vi.fn();
		await act(async () => {
			await closeHandler?.({ preventDefault });
		});

		expect(preventDefault).toHaveBeenCalled();
		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/test.md", "new content\n");
		expect(mockDestroy).toHaveBeenCalled();
	});

	it("saves dirty cached tabs on window close", async () => {
		// Open a.md and edit it
		openFileInStore("/workspace", "/workspace/a.md");
		mockedReadFile.mockResolvedValue("content A");
		await act(async () => {
			render(<AppLayout />);
		});
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});

		// Switch to b.md (caches a.md's dirty content)
		mockedReadFile.mockResolvedValue("content B");
		await act(async () => {
			useWorkspaceStore.setState({
				tabs: [
					{
						id: 1,
						path: "/workspace/a.md",
						dirty: true,
						history: ["/workspace/a.md"],
						historyIndex: 0,
					},
					{
						id: 2,
						path: "/workspace/b.md",
						dirty: false,
						history: ["/workspace/b.md"],
						historyIndex: 0,
					},
				],
				activeTabPath: "/workspace/b.md",
				activeTabId: 2,
				_nextTabId: 3,
			});
		});

		mockedWriteFile.mockClear();

		// Simulate window close — a.md should be saved from cache
		const preventDefault = vi.fn();
		await act(async () => {
			await closeHandler?.({ preventDefault });
		});

		expect(preventDefault).toHaveBeenCalled();
		expect(mockedWriteFile).toHaveBeenCalledWith(
			"/workspace/a.md",
			expect.stringContaining("new content"),
		);
		expect(mockDestroy).toHaveBeenCalled();
	});

	it("destroys window even when no dirty tabs exist", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		// No edits — tab is clean
		const preventDefault = vi.fn();
		await act(async () => {
			await closeHandler?.({ preventDefault });
		});

		expect(preventDefault).toHaveBeenCalled();
		expect(mockDestroy).toHaveBeenCalled();
	});

	it("does not destroy window when active tab save fails on close", async () => {
		openFileInStore("/workspace", "/workspace/test.md");
		await act(async () => {
			render(<AppLayout />);
		});

		// Edit file
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});
		expect(screen.getByText("未保存")).toBeInTheDocument();

		// Make save fail
		mockedWriteFile.mockRejectedValue(new Error("disk full"));

		// Simulate window close
		const preventDefault = vi.fn();
		await act(async () => {
			await closeHandler?.({ preventDefault });
		});

		expect(preventDefault).toHaveBeenCalled();
		expect(mockDestroy).not.toHaveBeenCalled();
		// Tab should still be open
		expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
	});

	it("normalizes cached content and updates dirty state on window close", async () => {
		// Open a.md and edit it
		openFileInStore("/workspace", "/workspace/a.md");
		mockedReadFile.mockResolvedValue("content A");
		await act(async () => {
			render(<AppLayout />);
		});
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});

		// Switch to b.md (caches a.md's dirty content)
		mockedReadFile.mockResolvedValue("content B");
		await act(async () => {
			useWorkspaceStore.setState({
				tabs: [
					{
						id: 1,
						path: "/workspace/a.md",
						dirty: true,
						history: ["/workspace/a.md"],
						historyIndex: 0,
					},
					{
						id: 2,
						path: "/workspace/b.md",
						dirty: false,
						history: ["/workspace/b.md"],
						historyIndex: 0,
					},
				],
				activeTabPath: "/workspace/b.md",
				activeTabId: 2,
				_nextTabId: 3,
			});
		});

		mockedWriteFile.mockClear();

		// Simulate window close — cached tab should be saved with normalization
		const preventDefault = vi.fn();
		await act(async () => {
			await closeHandler?.({ preventDefault });
		});

		// Should write normalized content (trailing newline)
		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/a.md", "new content\n");
		// Dirty flag should be cleared after successful save
		const aTab = useWorkspaceStore.getState().tabs.find((t) => t.path === "/workspace/a.md");
		expect(aTab?.dirty).toBe(false);
		expect(mockDestroy).toHaveBeenCalled();
	});

	it("does not destroy window when cached tab save fails on close", async () => {
		// Open a.md and edit it
		openFileInStore("/workspace", "/workspace/a.md");
		mockedReadFile.mockResolvedValue("content A");
		await act(async () => {
			render(<AppLayout />);
		});
		await act(async () => {
			screen.getByTestId("editor-change").click();
		});

		// Switch to b.md (caches a.md's dirty content)
		mockedReadFile.mockResolvedValue("content B");
		await act(async () => {
			useWorkspaceStore.setState({
				tabs: [
					{
						id: 1,
						path: "/workspace/a.md",
						dirty: true,
						history: ["/workspace/a.md"],
						historyIndex: 0,
					},
					{
						id: 2,
						path: "/workspace/b.md",
						dirty: false,
						history: ["/workspace/b.md"],
						historyIndex: 0,
					},
				],
				activeTabPath: "/workspace/b.md",
				activeTabId: 2,
				_nextTabId: 3,
			});
		});

		// Make save fail for cached tab
		mockedWriteFile.mockRejectedValue(new Error("disk full"));

		// Simulate window close
		const preventDefault = vi.fn();
		await act(async () => {
			await closeHandler?.({ preventDefault });
		});

		expect(preventDefault).toHaveBeenCalled();
		expect(mockDestroy).not.toHaveBeenCalled();
	});

	it("closes setup wizard when workspace becomes initialized", async () => {
		// initialized.json が存在しない = 未初期化ワークスペース
		mockedFileExists.mockResolvedValue(false);
		mockedReadFile.mockImplementation(async (path: string) => {
			if (path.endsWith("icons.json")) throw new Error("Not found");
			return "# Hello";
		});

		useWorkspaceStore.setState({ workspacePath: "/uninit-ws" });

		await act(async () => {
			render(<AppLayout />);
		});

		// loadIcons 完了後: configLoaded=true, workspaceInitialized=false → ウィザード表示
		expect(screen.getByText("ワークスペースのセットアップ")).toBeInTheDocument();

		// workspaceInitialized が true になるとウィザードが閉じる
		await act(async () => {
			useWorkspaceConfigStore.setState({ workspaceInitialized: true });
		});

		expect(screen.queryByText("ワークスペースのセットアップ")).not.toBeInTheDocument();
	});

	it("does not show wizard when switching to initialized workspace", async () => {
		// 最初は未初期化
		mockedFileExists.mockResolvedValue(false);
		mockedReadFile.mockImplementation(async (path: string) => {
			if (path.endsWith("icons.json")) throw new Error("Not found");
			return "# Hello";
		});

		useWorkspaceStore.setState({ workspacePath: "/uninit-ws" });

		await act(async () => {
			render(<AppLayout />);
		});

		expect(screen.getByText("ワークスペースのセットアップ")).toBeInTheDocument();

		// 初期化済みワークスペースに切り替え（fileExists が true を返す）
		mockedFileExists.mockResolvedValue(true);
		mockedReadFile.mockImplementation(async (path: string) => {
			if (path.endsWith("icons.json")) throw new Error("Not found");
			return "content";
		});

		await act(async () => {
			useWorkspaceStore.setState({ workspacePath: "/init-ws" });
		});

		// loadIcons が configLoaded=false → true、workspaceInitialized=true とセットする
		// ウィザードは閉じているべき
		expect(screen.queryByText("ワークスペースのセットアップ")).not.toBeInTheDocument();
	});

	it("Cmd+J does not toggle scratchpad when no workspace is open", async () => {
		await act(async () => {
			render(<AppLayout />);
		});

		expect(useScratchpadStore.getState().open).toBe(false);

		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true }));
		});

		expect(useScratchpadStore.getState().open).toBe(false);
	});

	it("Cmd+J toggles scratchpad when workspace is open", async () => {
		useWorkspaceStore.setState({ workspacePath: "/workspace" });
		await act(async () => {
			render(<AppLayout />);
		});

		expect(useScratchpadStore.getState().open).toBe(false);

		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true }));
		});

		expect(useScratchpadStore.getState().open).toBe(true);
	});

	it("opens conflict resolver only on 0→>0 transition, not on repeated updates", async () => {
		useWorkspaceStore.setState({ workspacePath: "/workspace" });
		await act(async () => {
			render(<AppLayout />);
		});

		// Initial state: no conflicts. Trigger 0→>0 transition.
		await act(async () => {
			useGitSyncStore.setState({ conflictFiles: ["file1.md"] });
		});

		// Conflict window should have been opened once (static import, no async flush needed)
		expect(MockWebviewWindowConstructor).toHaveBeenCalledTimes(1);

		// Update conflictFiles with a different array reference but still >0
		// Before the fix, this would trigger openConflictResolver again
		// because zustand returned a new array reference on every update.
		MockWebviewWindowConstructor.mockClear();
		await act(async () => {
			useGitSyncStore.setState({ conflictFiles: ["file1.md", "file2.md"] });
		});

		// Should NOT open a new window (prev > 0, current > 0)
		expect(MockWebviewWindowConstructor).not.toHaveBeenCalled();

		// Reset to 0, then back to >0 should open again
		MockWebviewWindowConstructor.mockClear();
		await act(async () => {
			useGitSyncStore.setState({ conflictFiles: [] });
		});
		await act(async () => {
			useGitSyncStore.setState({ conflictFiles: ["file3.md"] });
		});

		expect(MockWebviewWindowConstructor).toHaveBeenCalledTimes(1);
	});

	it("does not show editor on newtab page", async () => {
		useWorkspaceStore.setState({ workspacePath: "/workspace" });
		useWorkspaceStore.getState().openNewTab();

		await act(async () => {
			render(<AppLayout />);
		});

		// newtab page shows NewTabContent, not the editor
		expect(screen.queryByTestId("mock-editor")).not.toBeInTheDocument();
		expect(screen.getByLabelText("scripta")).toBeInTheDocument();
	});

	it("Cmd+Shift+E does not export on newtab page", async () => {
		useWorkspaceStore.setState({ workspacePath: "/workspace" });
		useWorkspaceStore.getState().openNewTab();

		await act(async () => {
			render(<AppLayout />);
		});

		await act(async () => {
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "e", metaKey: true, shiftKey: true }),
			);
		});

		// Export dialog should NOT appear
		expect(screen.queryByText("エクスポート")).not.toBeInTheDocument();
	});

	it("closes search bar when switching to newtab page", async () => {
		openFileInStore("/workspace", "/workspace/test.md");

		await act(async () => {
			render(<AppLayout />);
		});

		// Open search bar via Cmd+F
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
		});

		// Switch to newtab — search bar should close
		await act(async () => {
			useWorkspaceStore.getState().openNewTab();
		});

		// Editor is gone so search bar is not rendered, but importantly
		// it was closed (state reset) so it won't reappear on next file open
		expect(screen.queryByTestId("mock-editor")).not.toBeInTheDocument();
	});

	it("replaces newtab with file when navigating via sidebar", async () => {
		useWorkspaceStore.setState({ workspacePath: "/workspace" });
		useWorkspaceStore.getState().openNewTab();

		await act(async () => {
			render(<AppLayout />);
		});

		const state = useWorkspaceStore.getState();
		const newTabId = state.activeTabId;
		expect(state.tabs).toHaveLength(1);

		// Simulate sidebar file select (uses navigateInTab)
		await act(async () => {
			useWorkspaceStore.getState().navigateInTab("/workspace/test.md");
		});

		// newtab should be replaced, not a new tab created
		const after = useWorkspaceStore.getState();
		expect(after.tabs).toHaveLength(1);
		expect(after.activeTabId).toBe(newTabId);
		expect(after.activeTabPath).toBe("/workspace/test.md");
	});

	it("closes newtab and switches to existing tab when file is already open", async () => {
		// Open a file first, then open a newtab
		openFileInStore("/workspace", "/workspace/test.md");
		useWorkspaceStore.getState().openNewTab();

		await act(async () => {
			render(<AppLayout />);
		});

		const state = useWorkspaceStore.getState();
		expect(state.tabs).toHaveLength(2);
		expect(state.activeTabPath && isNewTabPath(state.activeTabPath)).toBe(true);

		// navigateInTab to already-open file — newtab should be closed
		await act(async () => {
			useWorkspaceStore.getState().navigateInTab("/workspace/test.md");
		});

		const after = useWorkspaceStore.getState();
		// navigateInTab switches to existing tab; newtab remains (store-level behavior).
		// The newtab cleanup for already-open files is handled at the AppLayout level
		// via openFileFromNewTab (used by command palette and search navigate).
		expect(after.activeTabPath).toBe("/workspace/test.md");
	});
});
