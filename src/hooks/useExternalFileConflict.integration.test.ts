import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	advance,
	createDeferred,
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

	it("戻らずにウィンドウを閉じようとすると、何も書かずに打ち切り、そのタブへ切り替えてダイアログを出す", async () => {
		const { result, editor } = await renderBoth();
		await leaveDirtyTabAndModifyExternally(editor, "EXTERNAL\n");

		let saveResult: string | undefined;
		await act(async () => {
			saveResult = await result.current.manager.saveAllTabs();
		});
		await flushAsync();
		await advance(5000);

		expect(saveResult).toBe("conflict");
		expect(writesTo("/w/a.md")).toEqual([]);
		expect(useWorkspaceStore.getState().activeTabPath).toBe("/w/a.md");
		expect(result.current.conflict.externalConflict).toEqual({
			path: "/w/a.md",
			type: "modified",
		});
	});

	it("ダイアログの表示中にウィンドウを閉じようとすると、何も書かずに打ち切る", async () => {
		const { result, editor } = await renderBoth();
		await leaveDirtyTabAndModifyExternally(editor, "EXTERNAL\n");
		await act(async () => {
			useWorkspaceStore.getState().setActiveTab("/w/a.md");
		});
		await flushAsync();
		expect(result.current.conflict.externalConflict).not.toBeNull();

		let saveResult: string | undefined;
		await act(async () => {
			saveResult = await result.current.manager.saveAllTabs();
		});

		expect(saveResult).toBe("conflict");
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it("ダイアログで「保持」を選んだ後なら、閉じるときに未保存の編集を書き込む", async () => {
		const { result, editor } = await renderBoth();
		await leaveDirtyTabAndModifyExternally(editor, "EXTERNAL\n");
		await act(async () => {
			useWorkspaceStore.getState().setActiveTab("/w/a.md");
		});
		await flushAsync();
		act(() => {
			result.current.conflict.handleConflictKeep();
		});

		let saveResult: string | undefined;
		await act(async () => {
			saveResult = await result.current.manager.saveAllTabs();
		});

		expect(saveResult).toBe("ok");
		expect(writesTo("/w/a.md")).toEqual([["/w/a.md", "edited A\n"]]);
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

	it("autosave の retry 中にダイアログで「再読み込み」を選んでも、タブは clean で落ち着く", async () => {
		const { result, editor } = await renderBoth();
		editor.type("edited A");
		mockedWriteFile.mockRejectedValueOnce("Connection timed out");
		act(() => {
			result.current.manager.scheduleAutoSave();
		});
		await advance(2000);
		expect(result.current.manager.saveStatus).toBe("retrying");

		diskContents.set("/w/a.md", "EXTERNAL\n");
		await emitModified("/w/a.md");
		act(() => {
			result.current.conflict.handleConflictReload();
		});
		await flushAsync();
		await advance(5000);

		expect(editor.getContent()).toBe("EXTERNAL\n");
		expect(result.current.manager.saveStatus).toBe("saved");
		expect(useWorkspaceStore.getState().tabs.find((t) => t.path === "/w/a.md")?.dirty).toBe(false);
	});

	/** 打鍵して debounce を張り、1 秒後に disk の a.md の読み込みを止めたまま外部変更を通知する。 */
	async function typeThenNotifyWithPendingRead(editor: FakeEditor, schedule: () => void) {
		editor.type("edited A");
		act(() => {
			schedule();
		});
		await advance(1000);
		const read = createDeferred<string>();
		mockedReadFile.mockImplementationOnce(() => read.promise);
		await emitModified("/w/a.md");
		return read;
	}

	it("外部変更を読み終える前に debounce の期限が来ても書き込まず、読み終えたらダイアログを出す", async () => {
		const { result, editor } = await renderBoth();
		const read = await typeThenNotifyWithPendingRead(
			editor,
			result.current.manager.scheduleAutoSave,
		);

		await advance(5000);
		expect(writesTo("/w/a.md")).toEqual([]);

		read.resolve("EXTERNAL\n");
		await flushAsync();
		await advance(5000);

		expect(result.current.conflict.externalConflict).toEqual({
			path: "/w/a.md",
			type: "modified",
		});
		expect(writesTo("/w/a.md")).toEqual([]);
	});

	it("読み込んだ内容が自分の書いた内容なら autosave を再開し、未保存の編集を書き込む", async () => {
		const { result, editor } = await renderBoth();
		const read = await typeThenNotifyWithPendingRead(
			editor,
			result.current.manager.scheduleAutoSave,
		);

		read.resolve("orig A\n");
		await flushAsync();
		await advance(3000);

		expect(result.current.conflict.externalConflict).toBeNull();
		expect(writesTo("/w/a.md")).toEqual([["/w/a.md", "edited A\n"]]);
	});

	it("読み込みに失敗したら autosave を再開し、未保存の編集を書き込む", async () => {
		const { result, editor } = await renderBoth();
		const read = await typeThenNotifyWithPendingRead(
			editor,
			result.current.manager.scheduleAutoSave,
		);

		read.reject(new Error("read failed"));
		await flushAsync();
		await advance(3000);

		expect(result.current.conflict.externalConflict).toBeNull();
		expect(writesTo("/w/a.md")).toEqual([["/w/a.md", "edited A\n"]]);
	});

	it("ダイアログで「保持」を選んでも、2 件目の外部変更を読み終えるまで書き込まない", async () => {
		const { result, editor } = await renderBoth();
		editor.type("edited A");
		act(() => {
			result.current.manager.scheduleAutoSave();
		});
		diskContents.set("/w/a.md", "EXTERNAL 1\n");
		await emitModified("/w/a.md");
		expect(result.current.conflict.externalConflict).not.toBeNull();

		const second = createDeferred<string>();
		mockedReadFile.mockImplementationOnce(() => second.promise);
		await emitModified("/w/a.md");
		act(() => {
			result.current.conflict.handleConflictKeep();
		});
		await advance(5000);
		expect(writesTo("/w/a.md")).toEqual([]);

		second.resolve("EXTERNAL 2\n");
		await flushAsync();
		await advance(5000);
		expect(result.current.conflict.externalConflict).toEqual({
			path: "/w/a.md",
			type: "modified",
		});
		expect(writesTo("/w/a.md")).toEqual([]);
	});

	it("「再読み込み」の読み込み中に別の読み込みが先に終わっても、書き込まずに外部変更を反映する", async () => {
		const { result, editor } = await renderBoth();
		editor.type("edited A");
		act(() => {
			result.current.manager.scheduleAutoSave();
		});
		diskContents.set("/w/a.md", "EXTERNAL\n");
		await emitModified("/w/a.md");
		expect(result.current.conflict.externalConflict).not.toBeNull();

		const second = createDeferred<string>();
		mockedReadFile.mockImplementationOnce(() => second.promise);
		await emitModified("/w/a.md");
		const reload = createDeferred<string>();
		mockedReadFile.mockImplementationOnce(() => reload.promise);
		act(() => {
			result.current.conflict.handleConflictReload();
		});

		second.reject(new Error("read failed"));
		await flushAsync();
		await advance(5000);
		expect(writesTo("/w/a.md")).toEqual([]);

		reload.resolve("EXTERNAL\n");
		await flushAsync();
		await advance(5000);
		expect(editor.getContent()).toBe("EXTERNAL\n");
		expect(writesTo("/w/a.md")).toEqual([]);
	});

	it("「再読み込み」の後に次の外部変更で「保持」を選ぶと、autosave が再開する", async () => {
		const { result, editor } = await renderBoth();
		editor.type("edited A");
		act(() => {
			result.current.manager.scheduleAutoSave();
		});
		diskContents.set("/w/a.md", "EXTERNAL 1\n");
		await emitModified("/w/a.md");
		act(() => {
			result.current.conflict.handleConflictReload();
		});
		await flushAsync();
		expect(editor.getContent()).toBe("EXTERNAL 1\n");

		editor.type("edited again");
		act(() => {
			result.current.manager.scheduleAutoSave();
		});
		diskContents.set("/w/a.md", "EXTERNAL 2\n");
		await emitModified("/w/a.md");
		act(() => {
			result.current.conflict.handleConflictKeep();
		});
		await advance(3000);

		expect(writesTo("/w/a.md")).toEqual([["/w/a.md", "edited again\n"]]);
	});

	it("「再読み込み」が読み込みに失敗した後、削除ダイアログで「保持」を選ぶと autosave が再開する", async () => {
		const { result, editor } = await renderBoth();
		editor.type("edited A");
		act(() => {
			result.current.manager.scheduleAutoSave();
		});
		diskContents.set("/w/a.md", "EXTERNAL\n");
		await emitModified("/w/a.md");
		mockedReadFile.mockRejectedValueOnce(new Error("ENOENT"));
		act(() => {
			result.current.conflict.handleConflictReload();
		});
		await flushAsync();
		expect(result.current.conflict.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });

		act(() => {
			result.current.conflict.handleDeletedDirtyKeep();
		});
		await advance(3000);

		expect(writesTo("/w/a.md")).toEqual([["/w/a.md", "edited A\n"]]);
	});

	it("2 件の読み込みが重なったら、両方を読み終えるまで autosave を止める", async () => {
		const { result, editor } = await renderBoth();
		const first = await typeThenNotifyWithPendingRead(
			editor,
			result.current.manager.scheduleAutoSave,
		);
		const second = createDeferred<string>();
		mockedReadFile.mockImplementationOnce(() => second.promise);
		await emitModified("/w/a.md");

		first.resolve("orig A\n");
		await flushAsync();
		await advance(5000);
		expect(writesTo("/w/a.md")).toEqual([]);

		second.resolve("orig A\n");
		await flushAsync();
		await advance(3000);
		expect(writesTo("/w/a.md")).toEqual([["/w/a.md", "edited A\n"]]);
	});
});
