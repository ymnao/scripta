import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	advance,
	createFakeEditor,
	type FakeEditor,
	flushAsync,
	resetWorkspace,
	seedWorkspace,
	tabPaths,
} from "../__test-utils__/tab-content-fixture";
import {
	onFsChange,
	onWorkspaceReloadTree,
	readFile,
	startWatcher,
	stopWatcher,
	writeFile,
} from "../lib/commands";
import type { FsChangeEvent } from "../types/workspace";

vi.mock("../lib/commands", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	startWatcher: vi.fn(),
	stopWatcher: vi.fn(),
	onFsChange: vi.fn(),
	onWorkspaceReloadTree: vi.fn(),
}));

vi.mock("../lib/store", () => ({
	DEFAULT_FILE_TREE_EXCLUDE_PATTERNS: "",
	saveSetting: vi.fn(),
}));

vi.mock("../stores/toast", () => {
	const addToast = vi.fn().mockReturnValue("toast-1");
	return { useToastStore: { getState: () => ({ addToast }) } };
});

const { useTabContentManager } = await import("./useTabContentManager");
const { useExternalFileConflict } = await import("./useExternalFileConflict");
const { useWorkspaceStore } = await import("../stores/workspace");
const { useSettingsStore } = await import("../stores/settings");

const mockedReadFile = readFile as Mock;
const mockedWriteFile = writeFile as Mock;

/** useFileWatcher の固定バッチ deadline (useFileWatcher.ts の setTimeout(flush, 300))。 */
const WATCHER_BATCH_MS = 300;

let diskContents: Map<string, string>;
let fsChangeCallback: ((events: FsChangeEvent[]) => void) | null = null;

async function emitModified(path: string): Promise<void> {
	act(() => {
		fsChangeCallback?.([{ path, kind: "modify" }]);
	});
	await advance(WATCHER_BATCH_MS);
	await flushAsync();
}

/** AppLayout と同じ配線で 2 つの hook を組む。 */
async function renderBoth(editor: FakeEditor = createFakeEditor()) {
	const rendered = renderHook(() => {
		const manager = useTabContentManager({
			editorViewRef: editor.ref,
			onTabSwitch: () => {},
			onGoToLine: () => {},
		});
		const conflict = useExternalFileConflict({ ...manager, onTreeChange: () => {} });
		const remountTokenRef = useRef<number | null>(null);
		if (remountTokenRef.current !== manager.editorKey) {
			remountTokenRef.current = manager.editorKey;
			editor.remountWith(manager.loadedDoc);
		}
		return { manager, conflict };
	});
	await flushAsync();
	return { ...rendered, editor };
}

function writesTo(path: string): unknown[][] {
	return mockedWriteFile.mock.calls.filter(([p]) => p === path);
}

/**
 * #703 の再現手順の 1-3: a を編集し、切替時の flush を失敗させて dirty のまま cache に
 * 残し、その間に disk の a を外部で書き換える。
 */
async function leaveDirtyTabAndModifyExternally(
	editor: FakeEditor,
	external: string,
): Promise<void> {
	editor.type("edited A");
	mockedWriteFile.mockRejectedValueOnce(new Error("flush failed"));
	await act(async () => {
		useWorkspaceStore.getState().setActiveTab("/w/b.md");
	});
	await flushAsync();
	diskContents.set("/w/a.md", external);
	await emitModified("/w/a.md");
	mockedWriteFile.mockClear();
}

describe("非 active の dirty タブへの外部変更 (#703)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		diskContents = new Map([
			["/w/a.md", "orig A\n"],
			["/w/b.md", "orig B\n"],
		]);
		fsChangeCallback = null;
		mockedReadFile.mockReset().mockImplementation((path: string) => {
			return Promise.resolve(diskContents.get(path) ?? `disk:${path}`);
		});
		mockedWriteFile.mockReset().mockResolvedValue(undefined);
		(startWatcher as Mock).mockReset().mockResolvedValue(undefined);
		(stopWatcher as Mock).mockReset().mockResolvedValue(undefined);
		(onFsChange as Mock).mockReset().mockImplementation((cb: (events: FsChangeEvent[]) => void) => {
			fsChangeCallback = cb;
			return () => {
				fsChangeCallback = null;
			};
		});
		(onWorkspaceReloadTree as Mock).mockReset().mockImplementation(() => () => {});
		resetWorkspace();
		useSettingsStore.setState({ trimTrailingWhitespace: true, autoSaveDelay: 2000 });
		seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("戻ると競合ダイアログが出て、選ぶまで autosave が外部変更を上書きしない", async () => {
		const { result, editor } = await renderBoth();
		await leaveDirtyTabAndModifyExternally(editor, "EXTERNAL\n");
		expect(result.current.conflict.externalConflict).toBeNull();

		await act(async () => {
			useWorkspaceStore.getState().setActiveTab("/w/a.md");
		});
		await flushAsync();
		await advance(5000);

		expect(result.current.conflict.externalConflict).toEqual({
			path: "/w/a.md",
			type: "modified",
		});
		expect(writesTo("/w/a.md")).toEqual([]);
	});

	it("ダイアログで「保持」を選ぶと、未保存の編集を autosave が書き込む", async () => {
		const { result, editor } = await renderBoth();
		await leaveDirtyTabAndModifyExternally(editor, "EXTERNAL\n");
		await act(async () => {
			useWorkspaceStore.getState().setActiveTab("/w/a.md");
		});
		await flushAsync();

		act(() => {
			result.current.conflict.handleConflictKeep();
		});
		await advance(3000);

		expect(result.current.conflict.externalConflict).toBeNull();
		expect(writesTo("/w/a.md")).toEqual([["/w/a.md", "edited A\n"]]);
	});

	it("ダイアログで「再読み込み」を選ぶと、外部変更を表示して書き込まない", async () => {
		const { result, editor } = await renderBoth();
		await leaveDirtyTabAndModifyExternally(editor, "EXTERNAL\n");
		await act(async () => {
			useWorkspaceStore.getState().setActiveTab("/w/a.md");
		});
		await flushAsync();

		act(() => {
			result.current.conflict.handleConflictReload();
		});
		await flushAsync();
		await advance(5000);

		expect(editor.getContent()).toBe("EXTERNAL\n");
		expect(writesTo("/w/a.md")).toEqual([]);
		expect(useWorkspaceStore.getState().tabs.find((t) => t.path === "/w/a.md")?.dirty).toBe(false);
	});

	it("戻らずに閉じようとすると、書き込まずにそのタブへ切り替えてダイアログを出す", async () => {
		const { result, editor } = await renderBoth();
		await leaveDirtyTabAndModifyExternally(editor, "EXTERNAL\n");

		await act(async () => {
			await result.current.manager.handleCloseTab(1);
		});
		await flushAsync();
		await advance(5000);

		expect(writesTo("/w/a.md")).toEqual([]);
		expect(tabPaths()).toEqual(["/w/a.md", "/w/b.md"]);
		expect(useWorkspaceStore.getState().activeTabPath).toBe("/w/a.md");
		expect(result.current.conflict.externalConflict).toEqual({
			path: "/w/a.md",
			type: "modified",
		});
	});

	it("disk の内容が保存済みの本文のままなら記録せず、戻ると従来どおり autosave が保存する", async () => {
		const { result, editor } = await renderBoth();
		// 監視の通知は届いたが disk は変わっていない (自分が以前書いた内容のまま)。
		await leaveDirtyTabAndModifyExternally(editor, "orig A\n");
		await act(async () => {
			useWorkspaceStore.getState().setActiveTab("/w/a.md");
		});
		await flushAsync();
		await advance(3000);

		expect(result.current.conflict.externalConflict).toBeNull();
		expect(writesTo("/w/a.md")).toEqual([["/w/a.md", "edited A\n"]]);
	});

	it("disk の内容が cache の本文を整形したものなら自分の write とみなし、閉じると保存する", async () => {
		const { result, editor } = await renderBoth();
		await leaveDirtyTabAndModifyExternally(editor, "edited A\n");

		await act(async () => {
			await result.current.manager.handleCloseTab(1);
		});

		expect(result.current.conflict.externalConflict).toBeNull();
		expect(writesTo("/w/a.md")).toEqual([["/w/a.md", "edited A"]]);
		expect(tabPaths()).toEqual(["/w/b.md"]);
	});
});

describe("active の dirty タブへの外部変更", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		diskContents = new Map([["/w/a.md", "orig A\n"]]);
		fsChangeCallback = null;
		mockedReadFile.mockReset().mockImplementation((path: string) => {
			return Promise.resolve(diskContents.get(path) ?? `disk:${path}`);
		});
		mockedWriteFile.mockReset().mockResolvedValue(undefined);
		(startWatcher as Mock).mockReset().mockResolvedValue(undefined);
		(stopWatcher as Mock).mockReset().mockResolvedValue(undefined);
		(onFsChange as Mock).mockReset().mockImplementation((cb: (events: FsChangeEvent[]) => void) => {
			fsChangeCallback = cb;
			return () => {
				fsChangeCallback = null;
			};
		});
		(onWorkspaceReloadTree as Mock).mockReset().mockImplementation(() => () => {});
		resetWorkspace();
		useSettingsStore.setState({ trimTrailingWhitespace: true, autoSaveDelay: 2000 });
		seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("打鍵後の debounce 中に外部変更が来ると、ダイアログで選ぶまで書き込まない", async () => {
		const { result, editor } = await renderBoth();
		editor.type("edited A");
		act(() => {
			result.current.manager.scheduleAutoSave();
		});
		await advance(1000);
		diskContents.set("/w/a.md", "EXTERNAL\n");

		await emitModified("/w/a.md");
		await advance(5000);

		expect(result.current.conflict.externalConflict).toEqual({
			path: "/w/a.md",
			type: "modified",
		});
		expect(writesTo("/w/a.md")).toEqual([]);
	});
});
