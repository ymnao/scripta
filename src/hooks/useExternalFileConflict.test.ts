import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	advance,
	createDeferred,
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
} from "../lib/commands";
import type { FsChangeEvent } from "../types/workspace";

vi.mock("../lib/commands", () => ({
	readFile: vi.fn(),
	startWatcher: vi.fn().mockResolvedValue(undefined),
	stopWatcher: vi.fn().mockResolvedValue(undefined),
	onFsChange: vi.fn(),
	onWorkspaceReloadTree: vi.fn(),
}));

const { useExternalFileConflict } = await import("./useExternalFileConflict");
const { useWorkspaceStore } = await import("../stores/workspace");

const mockedReadFile = readFile as Mock;

/** path ごとの disk 内容。未登録の path は `disk:<path>` を返す。 */
let diskContents: Map<string, string>;

/**
 * useFileWatcher の固定バッチ deadline (useFileWatcher.ts の setTimeout(flush, 300))。
 * 実装側を変えたらここも追随させる。
 */
const WATCHER_BATCH_MS = 300;

/** useFileWatcher が張った listener。fs イベント注入の入口。 */
let fsChangeCallback: ((events: FsChangeEvent[]) => void) | null = null;

/**
 * watcher の固定バッチを跨いで fs イベントを配送する。
 * hook 側は watcher 経由でしか外部変更を受け取らないので、テストも
 * 直接 handler を呼ばずこの経路を通す (batch 整形の前提ごと固定する)。
 */
async function emitFsChange(events: FsChangeEvent[]): Promise<void> {
	act(() => {
		fsChangeCallback?.(events);
	});
	await advance(WATCHER_BATCH_MS);
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
async function renderConflict(overrides: { isCachedTabClean?: (path: string) => boolean } = {}) {
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
	// watcher が listener を張り終える (= fs イベントを注入できる) まで進める。
	await flushAsync();
	return { ...rendered, api };
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
			const { result } = await renderConflict();

			await emitFsChange(deleted("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });

			act(() => {
				useWorkspaceStore.setState({ workspacePath: "/w2" });
			});

			expect(result.current.externalConflict).toBeNull();
		});

		it("同じ workspace のままの再レンダーではダイアログを保持する", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			const { result, rerender } = await renderConflict();

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
			const { result, api } = await renderConflict();

			await emitFsChange(deleted("/w/other.md"));

			expect(result.current.externalConflict).toBeNull();
			expect(api.dropTab).not.toHaveBeenCalled();
			expect(tabPaths()).toEqual(["/w/a.md"]);
		});

		it("clean タブは dropTab + closeTab で黙って閉じる", async () => {
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, api } = await renderConflict();

			await emitFsChange(deleted("/w/a.md"));

			expect(api.dropTab).toHaveBeenCalledWith("/w/a.md");
			expect(tabPaths()).toEqual(["/w/b.md"]);
			expect(result.current.externalConflict).toBeNull();
		});

		it("dirty タブは deleted ダイアログを出し、タブは閉じない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			const { result, api } = await renderConflict();

			await emitFsChange(deleted("/w/a.md"));

			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });
			expect(api.dropTab).not.toHaveBeenCalled();
			expect(tabPaths()).toEqual(["/w/a.md"]);
		});

		it("既存の modified ダイアログを deleted が上書きする", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { result } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "modified" });

			await emitFsChange(deleted("/w/a.md"));

			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });
		});
	});

	// #458 finding 10: active dirty タブの非同期分岐。readFile の結果を見て
	// 自分の write か外部変更かを判定するため、race (タブ切替) や reject も含めて固定する。
	describe("active dirty タブの外部変更判定", () => {
		it("読み込んだ内容が getLastSavedContent と一致するなら自分の write なのでダイアログを出さない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "last-saved");
			const { result } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));

			expect(result.current.externalConflict).toBeNull();
		});

		it("読み込んだ内容が異なるなら modified ダイアログを出す", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { result } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));

			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "modified" });
		});

		it("readFile が解決する前に activeTabPath が別タブへ変わったら結果を捨てる", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: true },
					{ path: "/w/b.md", dirty: false },
				],
				"/w/a.md",
			);
			const deferred = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => deferred.promise);
			const { result } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));

			act(() => {
				useWorkspaceStore.setState({ activeTabPath: "/w/b.md" });
			});
			act(() => {
				deferred.resolve("external-change");
			});
			await flushAsync();

			expect(result.current.externalConflict).toBeNull();
		});

		it("readFile が reject したら状態を維持する", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			mockedReadFile.mockImplementationOnce(() => Promise.reject(new Error("read failed")));
			const { result } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));

			expect(result.current.externalConflict).toBeNull();
		});

		it("既に deleted ダイアログが出ている場合、modified で上書きしない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			const { result } = await renderConflict();

			await emitFsChange(deleted("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });

			diskContents.set("/w/a.md", "external-change");
			await emitFsChange(modified("/w/a.md"));

			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });
		});
	});

	// #458 finding 11: active clean タブと非 active タブの反映経路。cache 上の
	// 未保存編集を握り潰さないことと、反映先 API を取り違えないことを固定する。
	describe("active clean タブと非 active タブの反映", () => {
		it("active clean タブは applyExternalReload を呼ぶ (applyCacheReload は呼ばない)", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: false }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { api } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));

			expect(api.applyExternalReload).toHaveBeenCalledWith("/w/a.md", "external-change");
			expect(api.applyCacheReload).not.toHaveBeenCalled();
		});

		it("active clean タブの readFile 失敗では applyExternalReload を呼ばない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: false }], "/w/a.md");
			mockedReadFile.mockImplementationOnce(() => Promise.reject(new Error("read failed")));
			const { api } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));

			expect(api.applyExternalReload).not.toHaveBeenCalled();
		});

		it("非 active で cache が clean なら applyCacheReload を呼ぶ (applyExternalReload は呼ばない)", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: false },
					{ path: "/w/b.md", dirty: false },
				],
				"/w/a.md",
			);
			diskContents.set("/w/b.md", "external-change");
			const { api } = await renderConflict();

			await emitFsChange(modified("/w/b.md"));

			expect(api.applyCacheReload).toHaveBeenCalledWith("/w/b.md", "external-change");
			expect(api.applyExternalReload).not.toHaveBeenCalled();
		});

		it("非 active で isCachedTabClean が false なら readFile を発行しない", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: false },
					{ path: "/w/b.md", dirty: false },
				],
				"/w/a.md",
			);
			const { api } = await renderConflict({ isCachedTabClean: () => false });

			await emitFsChange(modified("/w/b.md"));

			expect(mockedReadFile).not.toHaveBeenCalled();
			expect(api.applyCacheReload).not.toHaveBeenCalled();
		});

		it("非 active clean の readFile 失敗では applyCacheReload を呼ばない", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: false },
					{ path: "/w/b.md", dirty: false },
				],
				"/w/a.md",
			);
			mockedReadFile.mockImplementationOnce(() => Promise.reject(new Error("read failed")));
			const { api } = await renderConflict();

			await emitFsChange(modified("/w/b.md"));

			expect(api.applyCacheReload).not.toHaveBeenCalled();
		});

		it("タブに無い path の modify では readFile を発行しない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: false }], "/w/a.md");
			const { result } = await renderConflict();

			await emitFsChange(modified("/w/missing.md"));

			expect(mockedReadFile).not.toHaveBeenCalled();
			expect(result.current.externalConflict).toBeNull();
		});
	});

	// codex-review qa-fixture (MEDIUM/92, MEDIUM/94) 起点。clean 判定と反映の間に
	// readFile の await が挟まるため、判定が失効した状態で適用すると
	// 「読み込み中に打った文字が消える」。適用直前の取り直しをここで固定する。
	describe("readFile 解決までに前提が失効した場合", () => {
		it("active clean タブが読み込み中に dirty 化したら、editor を上書きせず modified ダイアログにする", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: false }], "/w/a.md");
			const deferred = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => deferred.promise);
			const { result, api } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));

			// 読み込み中にユーザーが打ち始めた
			act(() => {
				useWorkspaceStore.getState().setTabDirty("/w/a.md", true);
			});
			act(() => {
				deferred.resolve("external-change");
			});
			await flushAsync();

			expect(api.applyExternalReload).not.toHaveBeenCalled();
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "modified" });
		});

		it("読み込み中に dirty 化しても、内容が自分の保存分と同じならダイアログを出さない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: false }], "/w/a.md");
			const deferred = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => deferred.promise);
			const { result, api } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));

			act(() => {
				useWorkspaceStore.getState().setTabDirty("/w/a.md", true);
			});
			act(() => {
				deferred.resolve("last-saved");
			});
			await flushAsync();

			expect(api.applyExternalReload).not.toHaveBeenCalled();
			expect(result.current.externalConflict).toBeNull();
		});

		it("読み込み中に delete が届いていたら、遅れて解決した modify は deleted を上書きしない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: false }], "/w/a.md");
			const deferred = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => deferred.promise);
			const { result } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));

			// 読み込み中に編集し、さらに外部で削除された
			act(() => {
				useWorkspaceStore.getState().setTabDirty("/w/a.md", true);
			});
			await emitFsChange(deleted("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });

			act(() => {
				deferred.resolve("external-change");
			});
			await flushAsync();

			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });
		});

		it("非 active タブの cache が読み込み中に dirty 化したら applyCacheReload しない", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: false },
					{ path: "/w/b.md", dirty: false },
				],
				"/w/a.md",
			);
			const deferred = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => deferred.promise);
			// 1 回目 (判定時) は clean、2 回目 (適用直前の取り直し) は dirty を返す
			let cleanCalls = 0;
			const { api } = await renderConflict({
				isCachedTabClean: () => {
					cleanCalls += 1;
					return cleanCalls === 1;
				},
			});

			await emitFsChange(modified("/w/b.md"));
			act(() => {
				deferred.resolve("external-change");
			});
			await flushAsync();

			expect(cleanCalls).toBe(2);
			expect(api.applyCacheReload).not.toHaveBeenCalled();
		});

		it("非 active タブの cache が clean のままなら applyCacheReload する", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: false },
					{ path: "/w/b.md", dirty: false },
				],
				"/w/a.md",
			);
			const deferred = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => deferred.promise);
			const { api } = await renderConflict();

			await emitFsChange(modified("/w/b.md"));
			act(() => {
				deferred.resolve("external-change");
			});
			await flushAsync();

			expect(api.applyCacheReload).toHaveBeenCalledWith("/w/b.md", "external-change");
		});
	});

	// #458 finding 12: コンフリクト操作ハンドラ。ダイアログの種類ごとに
	// 呼んでよい操作が違う (誤った種類での呼び出しは no-op になる) ことを固定する。
	describe("コンフリクト操作ハンドラ", () => {
		it("modified 表示中の handleConflictReload 成功で applyConflictReload を呼びダイアログを閉じる", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { result, api } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "modified" });

			diskContents.set("/w/a.md", "reloaded-content");
			act(() => {
				result.current.handleConflictReload();
			});
			await flushAsync();

			expect(api.applyConflictReload).toHaveBeenCalledWith("/w/a.md", "reloaded-content");
			expect(result.current.externalConflict).toBeNull();
		});

		it("modified 表示中の handleConflictReload が readFile reject したとき deleted ダイアログへ遷移する", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { result } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "modified" });

			mockedReadFile.mockImplementationOnce(() => Promise.reject(new Error("gone")));
			act(() => {
				result.current.handleConflictReload();
			});
			await flushAsync();

			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });
		});

		it("deleted 表示中に handleConflictReload を呼んでも no-op", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			const { result } = await renderConflict();

			await emitFsChange(deleted("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });

			act(() => {
				result.current.handleConflictReload();
			});
			await flushAsync();

			expect(mockedReadFile).not.toHaveBeenCalled();
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });
		});

		it("handleConflictKeep はダイアログを閉じるだけでタブを触らない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { result, api } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "modified" });

			act(() => {
				result.current.handleConflictKeep();
			});

			expect(result.current.externalConflict).toBeNull();
			expect(api.dropTab).not.toHaveBeenCalled();
			expect(tabPaths()).toEqual(["/w/a.md"]);
		});

		it("deleted 表示中の handleDeletedDirtyDiscard は dropTab + closeTab でタブを閉じる", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			const { result, api } = await renderConflict();

			await emitFsChange(deleted("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });

			act(() => {
				result.current.handleDeletedDirtyDiscard();
			});

			expect(api.dropTab).toHaveBeenCalledWith("/w/a.md");
			expect(tabPaths()).toEqual([]);
			expect(result.current.externalConflict).toBeNull();
		});

		it("modified 表示中に handleDeletedDirtyDiscard を呼んでも no-op", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { result, api } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "modified" });

			act(() => {
				result.current.handleDeletedDirtyDiscard();
			});

			expect(api.dropTab).not.toHaveBeenCalled();
			expect(tabPaths()).toEqual(["/w/a.md"]);
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "modified" });
		});

		it("handleDeletedDirtyKeep はダイアログを閉じるがタブは残す", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			const { result, api } = await renderConflict();

			await emitFsChange(deleted("/w/a.md"));
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });

			act(() => {
				result.current.handleDeletedDirtyKeep();
			});

			expect(result.current.externalConflict).toBeNull();
			expect(api.dropTab).not.toHaveBeenCalled();
			expect(tabPaths()).toEqual(["/w/a.md"]);
		});
	});
});
