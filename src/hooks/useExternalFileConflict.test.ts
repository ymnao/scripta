import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	advance,
	flushAsync,
	resetWorkspace,
	seedWorkspace,
	tabPaths,
} from "../__test-utils__/tab-content-fixture";
import { onFsChange, onWorkspaceReloadTree, readFile, startWatcher, stopWatcher } from "../lib/commands";
import type { FsChangeEvent } from "../types/workspace";

vi.mock("../lib/commands", () => ({
	readFile: vi.fn(),
	startWatcher: vi.fn().mockResolvedValue(undefined),
	stopWatcher: vi.fn().mockResolvedValue(undefined),
	onFsChange: vi.fn(),
	onWorkspaceReloadTree: vi.fn(),
}));

vi.mock("../stores/toast", () => {
	const addToast = vi.fn().mockReturnValue("toast-1");
	return { useToastStore: { getState: () => ({ addToast }) } };
});

const { useExternalFileConflict } = await import("./useExternalFileConflict");
const { useWorkspaceStore } = await import("../stores/workspace");

const mockedReadFile = readFile as Mock;

/** path ごとの disk 内容。未登録の path は `disk:<path>` を返す。 */
let diskContents: Map<string, string>;

/** useFileWatcher が張った listener。fs イベント注入の入口。 */
let fsChangeCallback: ((events: FsChangeEvent[]) => void) | null = null;

/**
 * watcher の 300ms 固定バッチを跨いで fs イベントを配送する。
 * hook 側は watcher 経由でしか外部変更を受け取らないので、テストも
 * 直接 handler を呼ばずこの経路を通す (batch 整形の前提ごと固定する)。
 */
async function emitFsChange(events: FsChangeEvent[]): Promise<void> {
	act(() => {
		fsChangeCallback?.(events);
	});
	await advance(300);
	await flushAsync();
}

function modified(path: string): FsChangeEvent[] {
	return [{ path, kind: "modify" }];
}

function deleted(path: string): FsChangeEvent[] {
	return [{ path, kind: "delete" }];
}

/**
 * tab API は `Pick<TabContentManager, ...>` なので実装を持ち込む必要が無い。
 * すべて vi.fn() で受け、「どの分岐がどの API を呼んだか」だけを観測する。
 */
function renderConflict(overrides: { isCachedTabClean?: (path: string) => boolean } = {}) {
	const api = {
		onTreeChange: vi.fn(),
		getLastSavedContent: vi.fn<() => string>().mockReturnValue("last-saved"),
		applyExternalReload: vi.fn(),
		applyCacheReload: vi.fn(),
		applyConflictReload: vi.fn(),
		dropTab: vi.fn(),
		isCachedTabClean: vi.fn(overrides.isCachedTabClean ?? (() => true)),
	};
	const rendered = renderHook(() => useExternalFileConflict(api));
	return { ...rendered, api };
}

/** watcher が listener を張り終える (= fs イベントを注入できる) まで進める。 */
async function mountWatcher(): Promise<void> {
	await flushAsync();
}

describe("useExternalFileConflict", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		diskContents = new Map();
		fsChangeCallback = null;
		mockedReadFile.mockReset().mockImplementation((path: string) => {
			return Promise.resolve(diskContents.get(path) ?? `disk:${path}`);
		});
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
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// #458 finding 8: workspace 切替でダイアログを破棄しないと、別 workspace の
	// パスが表示され続ける (操作すると存在しないファイルを触る)。
	describe("workspace 切替", () => {
		it("workspace が切り替わると表示中のダイアログを破棄する", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			const { result } = renderConflict();
			await mountWatcher();

			await emitFsChange(deleted("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });

			act(() => {
				useWorkspaceStore.setState({ workspacePath: "/w2" });
			});

			expect(result.current.externalConflict).toBeNull();
		});

		it("同じ workspace のままの再レンダーではダイアログを保持する", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			const { result, rerender } = renderConflict();
			await mountWatcher();

			await emitFsChange(deleted("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });

			act(() => {
				// workspacePath 以外の state 変化では破棄されないこと
				useWorkspaceStore.getState().bumpFileTreeVersion();
			});
			rerender();

			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });
		});
	});

	// #458 finding 9: 外部削除の 4 分岐。clean は黙って閉じ、dirty は必ず選択を求める
	// (黙って閉じると未保存の編集が消える)。
	describe("外部削除", () => {
		it("対象タブが無ければ何もしない", async () => {
			seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
			const { result, api } = renderConflict();
			await mountWatcher();

			await emitFsChange(deleted("/w/other.md"));

			expect(result.current.externalConflict).toBeNull();
			expect(api.dropTab).not.toHaveBeenCalled();
			expect(tabPaths()).toEqual(["/w/a.md"]);
		});

		it("clean タブは dropTab + closeTab で黙って閉じる", async () => {
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, api } = renderConflict();
			await mountWatcher();

			await emitFsChange(deleted("/w/a.md"));

			expect(api.dropTab).toHaveBeenCalledWith("/w/a.md");
			expect(tabPaths()).toEqual(["/w/b.md"]);
			expect(result.current.externalConflict).toBeNull();
		});

		it("dirty タブは deleted ダイアログを出し、タブは閉じない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			const { result, api } = renderConflict();
			await mountWatcher();

			await emitFsChange(deleted("/w/a.md"));

			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });
			expect(api.dropTab).not.toHaveBeenCalled();
			expect(tabPaths()).toEqual(["/w/a.md"]);
		});

		it("既存の modified ダイアログを deleted が上書きする", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { result } = renderConflict();
			await mountWatcher();

			await emitFsChange(modified("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "modified" });

			await emitFsChange(deleted("/w/a.md"));

			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });
		});
	});
});
