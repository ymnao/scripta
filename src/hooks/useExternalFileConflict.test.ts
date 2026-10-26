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
async function renderConflict(
	overrides: {
		isCachedTabClean?: (path: string) => boolean;
		getCachedContent?: (path: string) => string | null;
		takeCachedConflict?: (path: string) => boolean;
	} = {},
) {
	const api = {
		onTreeChange: vi.fn(),
		getLastSavedContent: vi.fn<() => string>().mockReturnValue("last-saved"),
		applyExternalReload: vi.fn(),
		applyCacheReload: vi.fn(),
		applyConflictReload: vi.fn(),
		dropTab: vi.fn(),
		isCachedTabClean: vi.fn(overrides.isCachedTabClean ?? (() => true)),
		getCachedContent: vi.fn(overrides.getCachedContent ?? (() => "cached")),
		markCachedTabConflict: vi.fn(),
		takeCachedConflict: vi.fn(overrides.takeCachedConflict ?? (() => false)),
		holdAutoSave: vi.fn(),
		releaseAutoSave: vi.fn(),
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

		it("readFile が解決する前に別タブへ切り替わったら、ダイアログではなく非 active タブとして記録する", async () => {
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
			// 切替時の flush が失敗して a の cache が dirty のまま残った状態。
			const { result, api } = await renderConflict({ isCachedTabClean: () => false });

			await emitFsChange(modified("/w/a.md"));

			act(() => {
				useWorkspaceStore.setState({ activeTabPath: "/w/b.md" });
			});
			act(() => {
				deferred.resolve("external-change");
			});
			await flushAsync();

			expect(result.current.externalConflict).toBeNull();
			expect(api.markCachedTabConflict).toHaveBeenCalledWith("/w/a.md", "external-change");
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

		it("非 active で cache が無ければ readFile を発行しない", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: false },
					{ path: "/w/b.md", dirty: false },
				],
				"/w/a.md",
			);
			const { api } = await renderConflict({ getCachedContent: () => null });

			await emitFsChange(modified("/w/b.md"));

			expect(mockedReadFile).not.toHaveBeenCalled();
			expect(api.applyCacheReload).not.toHaveBeenCalled();
			expect(api.markCachedTabConflict).not.toHaveBeenCalled();
		});

		it("非 active で cache が dirty なら、ダイアログを出さず markCachedTabConflict で記録する", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: false },
					{ path: "/w/b.md", dirty: true },
				],
				"/w/a.md",
			);
			diskContents.set("/w/b.md", "external-change");
			const { result, api } = await renderConflict({ isCachedTabClean: () => false });

			await emitFsChange(modified("/w/b.md"));

			expect(api.markCachedTabConflict).toHaveBeenCalledWith("/w/b.md", "external-change");
			expect(api.applyCacheReload).not.toHaveBeenCalled();
			expect(result.current.externalConflict).toBeNull();
			expect(api.holdAutoSave).not.toHaveBeenCalled();
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

		it("読み込み中に外部削除でタブが閉じたら、遅れて解決しても cache を作り直さない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: false }, "/w/b.md"], "/w/a.md");
			const deferred = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => deferred.promise);
			const { api } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));
			// clean なので delete は黙ってタブを閉じる
			await emitFsChange(deleted("/w/a.md"));
			expect(tabPaths()).toEqual(["/w/b.md"]);

			act(() => {
				deferred.resolve("external-change");
			});
			await flushAsync();

			// applyExternalReload は cache を作り直すので、閉じたタブに対して呼ばれると
			// dropTab で捨てた cache が復活する
			expect(api.applyExternalReload).not.toHaveBeenCalled();
		});

		it("読み込み中に workspace が切り替わったら、旧 workspace のパスへ反映しない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: false }], "/w/a.md");
			const deferred = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => deferred.promise);
			const { api } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));

			act(() => {
				seedWorkspace("/w2", ["/w2/x.md"], "/w2/x.md");
			});
			act(() => {
				deferred.resolve("external-change");
			});
			await flushAsync();

			expect(api.applyExternalReload).not.toHaveBeenCalled();
		});

		it("非 active タブの cache が読み込み中に dirty 化したら applyCacheReload せず記録する", async () => {
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
			let clean = true;
			const { api } = await renderConflict({ isCachedTabClean: () => clean });

			await emitFsChange(modified("/w/b.md"));
			clean = false;
			act(() => {
				deferred.resolve("external-change");
			});
			await flushAsync();

			expect(api.applyCacheReload).not.toHaveBeenCalled();
			expect(api.markCachedTabConflict).toHaveBeenCalledWith("/w/b.md", "external-change");
		});

		it("非 active タブが読み込み中に active 化して dirty になったら、記録ではなく modified ダイアログにする", async () => {
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
			const { result, api } = await renderConflict();

			await emitFsChange(modified("/w/b.md"));
			act(() => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
				useWorkspaceStore.getState().setTabDirty("/w/b.md", true);
			});
			act(() => {
				deferred.resolve("external-change");
			});
			await flushAsync();

			expect(result.current.externalConflict).toEqual({ path: "/w/b.md", type: "modified" });
			expect(api.holdAutoSave).toHaveBeenCalled();
			expect(api.markCachedTabConflict).not.toHaveBeenCalled();
			expect(api.applyCacheReload).not.toHaveBeenCalled();
		});

		it("非 active タブが読み込み中に active 化して clean のままなら、エディタへ反映する", async () => {
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
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			act(() => {
				deferred.resolve("external-change");
			});
			await flushAsync();

			expect(api.applyExternalReload).toHaveBeenCalledWith("/w/b.md", "external-change");
			expect(api.applyCacheReload).not.toHaveBeenCalled();
		});

		it("非 active タブが読み込み中に閉じられたら、cache へ反映しない", async () => {
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
				useWorkspaceStore.getState().closeTab("/w/b.md");
			});
			act(() => {
				deferred.resolve("external-change");
			});
			await flushAsync();

			expect(api.applyCacheReload).not.toHaveBeenCalled();
			expect(api.markCachedTabConflict).not.toHaveBeenCalled();
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

	// #703: ダイアログで選ぶ前に autosave が書き込むと外部の変更が消えるので、表示中は止める。
	describe("ダイアログ表示中の autosave 停止", () => {
		it("modified ダイアログを出すと holdAutoSave し、「保持」で releaseAutoSave する", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { result, api } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));
			// 読み込みの前 (#715) と、ダイアログを開くときの 2 回。
			expect(api.holdAutoSave).toHaveBeenCalledTimes(2);
			expect(api.releaseAutoSave).not.toHaveBeenCalled();

			act(() => {
				result.current.handleConflictKeep();
			});
			expect(api.releaseAutoSave).toHaveBeenCalledTimes(1);
		});

		// #715: ダイアログを開くまで待つと、読む間に debounce が発火して外部変更を上書きする。
		it("active で dirty なタブの外部変更は、読み終える前に holdAutoSave する", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			const read = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => read.promise);
			const { api } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));

			expect(api.holdAutoSave).toHaveBeenCalledTimes(1);
			expect(api.releaseAutoSave).not.toHaveBeenCalled();
		});

		it("active で clean なタブの外部変更では holdAutoSave しない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: false }], "/w/a.md");
			const read = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => read.promise);
			const { api } = await renderConflict();

			await emitFsChange(modified("/w/a.md"));

			expect(api.holdAutoSave).not.toHaveBeenCalled();
		});

		it("読み込み中にタブが閉じたら、反映せず autosave の停止だけ解く", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }, "/w/b.md"], "/w/a.md");
			const read = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => read.promise);
			const { api } = await renderConflict();
			await emitFsChange(modified("/w/a.md"));

			act(() => {
				useWorkspaceStore.getState().closeTab("/w/a.md");
			});
			read.resolve("external-change");
			await flushAsync();

			expect(api.releaseAutoSave).toHaveBeenCalledTimes(1);
			expect(api.applyExternalReload).not.toHaveBeenCalled();
			expect(api.applyCacheReload).not.toHaveBeenCalled();
		});

		it("読み込み中に保存が済んで clean になったら、停止を解いてから反映する", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			const read = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => read.promise);
			const { api } = await renderConflict();
			const order: string[] = [];
			api.releaseAutoSave.mockImplementation(() => order.push("release"));
			api.applyExternalReload.mockImplementation(() => order.push("apply"));
			await emitFsChange(modified("/w/a.md"));

			act(() => {
				useWorkspaceStore.getState().setTabDirty("/w/a.md", false);
			});
			read.resolve("external-change");
			await flushAsync();

			expect(order).toEqual(["release", "apply"]);
		});

		it("読み込み中に別のタブへ切り替えたら、停止を解いてから記録する", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }, "/w/b.md"], "/w/a.md");
			const read = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => read.promise);
			const { api } = await renderConflict({ isCachedTabClean: () => false });
			const order: string[] = [];
			api.releaseAutoSave.mockImplementation(() => order.push("release"));
			api.markCachedTabConflict.mockImplementation(() => order.push("mark"));
			await emitFsChange(modified("/w/a.md"));

			act(() => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			read.resolve("external-change");
			await flushAsync();

			expect(order).toEqual(["release", "mark"]);
		});

		it("「再読み込み」は disk の内容を読み終えてから、反映の直前に releaseAutoSave する", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { result, api } = await renderConflict();
			await emitFsChange(modified("/w/a.md"));

			const deferred = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => deferred.promise);
			act(() => {
				result.current.handleConflictReload();
			});
			expect(api.releaseAutoSave).not.toHaveBeenCalled();

			act(() => {
				deferred.resolve("reloaded");
			});
			await flushAsync();
			expect(api.releaseAutoSave).toHaveBeenCalledTimes(1);
			expect(api.releaseAutoSave.mock.invocationCallOrder[0]).toBeLessThan(
				api.applyConflictReload.mock.invocationCallOrder[0],
			);
		});

		it("「再読み込み」の読み込み中にタブが閉じたら、反映せず autosave の停止だけ解く", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { result, api } = await renderConflict();
			await emitFsChange(modified("/w/a.md"));

			const deferred = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => deferred.promise);
			act(() => {
				result.current.handleConflictReload();
			});
			act(() => {
				useWorkspaceStore.getState().closeTab("/w/a.md");
			});
			act(() => {
				deferred.resolve("reloaded");
			});
			await flushAsync();

			expect(api.applyConflictReload).not.toHaveBeenCalled();
			expect(api.releaseAutoSave).toHaveBeenCalledTimes(1);
		});

		it("「再読み込み」の読み込み中に別のダイアログが開いたら、反映後も止めたままにする", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: true },
					{ path: "/w/b.md", dirty: true },
				],
				"/w/a.md",
			);
			diskContents.set("/w/a.md", "external-change");
			const { result, api } = await renderConflict();
			await emitFsChange(modified("/w/a.md"));

			const deferred = createDeferred<string>();
			mockedReadFile.mockImplementationOnce(() => deferred.promise);
			act(() => {
				result.current.handleConflictReload();
			});
			await emitFsChange(deleted("/w/b.md"));
			act(() => {
				deferred.resolve("reloaded");
			});
			await flushAsync();

			expect(result.current.externalConflict).toEqual({ path: "/w/b.md", type: "deleted" });
			expect(api.releaseAutoSave).not.toHaveBeenCalled();
		});

		it("「再読み込み」が読み込みに失敗して deleted ダイアログへ移るときは止めたままにする", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { result, api } = await renderConflict();
			await emitFsChange(modified("/w/a.md"));

			mockedReadFile.mockImplementationOnce(() => Promise.reject(new Error("gone")));
			act(() => {
				result.current.handleConflictReload();
			});
			await flushAsync();

			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });
			expect(api.releaseAutoSave).not.toHaveBeenCalled();
		});

		it("deleted ダイアログも表示中は止め、「破棄」「保持」のどちらでも解く", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: true },
					{ path: "/w/b.md", dirty: true },
				],
				"/w/a.md",
			);
			const { result, api } = await renderConflict();

			await emitFsChange(deleted("/w/a.md"));
			expect(api.holdAutoSave).toHaveBeenCalledTimes(1);
			act(() => {
				result.current.handleDeletedDirtyKeep();
			});
			expect(api.releaseAutoSave).toHaveBeenCalledTimes(1);

			await emitFsChange(deleted("/w/b.md"));
			expect(api.holdAutoSave).toHaveBeenCalledTimes(2);
			act(() => {
				result.current.handleDeletedDirtyDiscard();
			});
			expect(api.releaseAutoSave).toHaveBeenCalledTimes(2);
		});

		it("workspace の切替でダイアログを破棄するときも解く", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			diskContents.set("/w/a.md", "external-change");
			const { api } = await renderConflict();
			await emitFsChange(modified("/w/a.md"));
			expect(api.releaseAutoSave).not.toHaveBeenCalled();

			act(() => {
				useWorkspaceStore.setState({ workspacePath: "/other" });
			});
			expect(api.releaseAutoSave).toHaveBeenCalledTimes(1);
		});
	});

	describe("非 active の間に記録された外部変更", () => {
		/** 実装と同じく、取り出すと消える記録。 */
		function recordedOnce(target: string) {
			const record = { pending: true };
			const take = (path: string): boolean => {
				if (path !== target || !record.pending) return false;
				record.pending = false;
				return true;
			};
			return { record, take };
		}

		it("記録のあるタブが active になると、modified ダイアログを出して autosave を止める", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: false },
					{ path: "/w/b.md", dirty: true },
				],
				"/w/a.md",
			);
			const { take } = recordedOnce("/w/b.md");
			const { result, api } = await renderConflict({ takeCachedConflict: take });
			expect(result.current.externalConflict).toBeNull();

			act(() => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});

			expect(api.takeCachedConflict).toHaveBeenLastCalledWith("/w/b.md");
			expect(result.current.externalConflict).toEqual({ path: "/w/b.md", type: "modified" });
			expect(api.holdAutoSave).toHaveBeenCalledTimes(1);
		});

		it("別のダイアログが出ている間は記録を取り出さず、閉じたあとに modified ダイアログを出す", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: true },
					{ path: "/w/b.md", dirty: true },
				],
				"/w/a.md",
			);
			const { record, take } = recordedOnce("/w/b.md");
			const { result, api } = await renderConflict({ takeCachedConflict: take });
			await emitFsChange(deleted("/w/a.md"));

			act(() => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			expect(result.current.externalConflict).toEqual({ path: "/w/a.md", type: "deleted" });
			expect(record.pending).toBe(true);

			act(() => {
				result.current.handleDeletedDirtyKeep();
			});
			expect(result.current.externalConflict).toEqual({ path: "/w/b.md", type: "modified" });
			expect(api.holdAutoSave).toHaveBeenCalledTimes(2);
		});

		it("記録の無いタブが active になってもダイアログを出さない", async () => {
			seedWorkspace(
				"/w",
				[
					{ path: "/w/a.md", dirty: false },
					{ path: "/w/b.md", dirty: true },
				],
				"/w/a.md",
			);
			const { result, api } = await renderConflict();

			act(() => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});

			expect(result.current.externalConflict).toBeNull();
			expect(api.holdAutoSave).not.toHaveBeenCalled();
		});
	});
});
