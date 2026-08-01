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
import { readFile, writeFile } from "../lib/commands";

vi.mock("../lib/commands", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
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
const { useWorkspaceStore } = await import("../stores/workspace");
const { useSettingsStore } = await import("../stores/settings");

const mockedReadFile = readFile as Mock;
const mockedWriteFile = writeFile as Mock;

/** path ごとの disk 内容。未登録の path は `disk:<path>` を返す。 */
let diskContents: Map<string, string>;

function renderManager(editor: FakeEditor = createFakeEditor()) {
	const onTabSwitch = vi.fn();
	const onGoToLine = vi.fn();
	const rendered = renderHook(() => {
		const manager = useTabContentManager({
			editorViewRef: editor.ref,
			onTabSwitch,
			onGoToLine,
		});
		// 実 MarkdownEditor は uncontrolled で、doc が外から置き換わるのは editorKey bump に
		// よる remount と restoreSnapshot (epoch bump) のときだけ。fake もその境界に合わせる
		// (合わせないと「ロードし直したはずの内容」が編集内容のまま残り、cache の assert が
		// 実挙動から乖離する)。
		const remountTokenRef = useRef<string | null>(null);
		const remountToken = `${manager.editorKey}:${manager.editorViewEpoch}`;
		if (remountTokenRef.current !== remountToken) {
			remountTokenRef.current = remountToken;
			editor.remountWith(manager.loadedDoc);
		}
		return manager;
	});
	return { ...rendered, editor, onTabSwitch, onGoToLine };
}

describe("useTabContentManager", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		diskContents = new Map();
		mockedReadFile.mockReset().mockImplementation((path: string) => {
			return Promise.resolve(diskContents.get(path) ?? `disk:${path}`);
		});
		mockedWriteFile.mockReset().mockResolvedValue(undefined);
		resetWorkspace();
		useSettingsStore.setState({ trimTrailingWhitespace: true, autoSaveDelay: 2000 });
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// #458: 抽出前は AppLayout に埋まっていて hook 単位では試験できなかった分岐。
	// prefix 境界の取り違えは「別ファイルの cache をユーザーの編集として書き戻す」経路に
	// 直結するため、兄弟パス (/a/foo と /a/foobar) を必ず同居させて assert する。
	describe("handleFileRenamed / handleFileDeleted の prefix 境界", () => {
		/** 非 active タブの clean cache を公開 API だけで seed する。 */
		function seedCache(
			manager: { applyCacheReload: (path: string, loaded: string) => void },
			entries: [string, string][],
		) {
			act(() => {
				for (const [path, content] of entries) {
					manager.applyCacheReload(path, content);
				}
			});
		}

		it("ディレクトリ rename で、同名 prefix を持つ兄弟ディレクトリの cache を巻き込まない", async () => {
			seedWorkspace("/w", ["/w/a/foo/x.md", "/w/a/foobar/y.md"], null);
			const { result } = renderManager();
			await flushAsync();

			seedCache(result.current, [
				["/w/a/foo/x.md", "x-content"],
				["/w/a/foobar/y.md", "y-content"],
			]);

			act(() => {
				result.current.handleFileRenamed("/w/a/foo", "/w/a/baz", true);
			});

			expect(result.current.getCachedContent("/w/a/baz/x.md")).toBe("x-content");
			expect(result.current.getCachedContent("/w/a/foo/x.md")).toBeNull();
			// 兄弟は移動対象に入らない。この性質は 2 層で守られており (走査側の
			// startsWith(prefix) と replacePrefix 自身の境界 guard)、mutation で確かめると
			// 片層だけ壊しても newKey === oldKey になるため挙動が変わらない (= 単層の
			// mutant は survive する)。この assert が pin しているのは「兄弟が動かない」
			// という性質そのもので、両層を同時に壊した mutant で KILL される。
			expect(result.current.getCachedContent("/w/a/foobar/y.md")).toBe("y-content");
			expect(result.current.getCachedContent("/w/a/bazbar/y.md")).toBeNull();
			expect(tabPaths()).toEqual(["/w/a/baz/x.md", "/w/a/foobar/y.md"]);
		});

		it("ディレクトリ rename で、cache の付け替え先が新 prefix になる", async () => {
			seedWorkspace("/w", ["/w/a/foo/deep/x.md"], null);
			const { result } = renderManager();
			await flushAsync();

			seedCache(result.current, [["/w/a/foo/deep/x.md", "deep-content"]]);

			act(() => {
				result.current.handleFileRenamed("/w/a/foo", "/w/a/baz", true);
			});

			// old/new を取り違えると付け替え先が元のままになり、新 path 側が null になる。
			expect(result.current.getCachedContent("/w/a/baz/deep/x.md")).toBe("deep-content");
			expect(tabPaths()).toEqual(["/w/a/baz/deep/x.md"]);
		});

		it("ディレクトリ削除で、同名 prefix を持つ兄弟ディレクトリの cache とタブを残す", async () => {
			seedWorkspace("/w", ["/w/a/foo/x.md", "/w/a/foobar/y.md"], null);
			const { result } = renderManager();
			await flushAsync();

			seedCache(result.current, [
				["/w/a/foo/x.md", "x-content"],
				["/w/a/foobar/y.md", "y-content"],
			]);

			act(() => {
				result.current.handleFileDeleted("/w/a/foo", true);
			});

			expect(result.current.getCachedContent("/w/a/foo/x.md")).toBeNull();
			expect(result.current.getCachedContent("/w/a/foobar/y.md")).toBe("y-content");
			expect(tabPaths()).toEqual(["/w/a/foobar/y.md"]);
		});

		it("ファイル rename は完全一致した cache だけを移し、prefix を共有する別ファイルを触らない", async () => {
			seedWorkspace("/w", ["/w/a/note.md", "/w/a/note.md.bak"], null);
			const { result } = renderManager();
			await flushAsync();

			seedCache(result.current, [
				["/w/a/note.md", "note-content"],
				["/w/a/note.md.bak", "bak-content"],
			]);

			act(() => {
				result.current.handleFileRenamed("/w/a/note.md", "/w/a/renamed.md", false);
			});

			expect(result.current.getCachedContent("/w/a/renamed.md")).toBe("note-content");
			expect(result.current.getCachedContent("/w/a/note.md")).toBeNull();
			expect(result.current.getCachedContent("/w/a/note.md.bak")).toBe("bak-content");
			expect(tabPaths()).toEqual(["/w/a/renamed.md", "/w/a/note.md.bak"]);
		});

		it("ファイル削除は完全一致した cache だけを捨て、prefix を共有する別ファイルを残す", async () => {
			seedWorkspace("/w", ["/w/a/note.md", "/w/a/note.md.bak"], null);
			const { result } = renderManager();
			await flushAsync();

			seedCache(result.current, [
				["/w/a/note.md", "note-content"],
				["/w/a/note.md.bak", "bak-content"],
			]);

			act(() => {
				result.current.handleFileDeleted("/w/a/note.md", false);
			});

			expect(result.current.getCachedContent("/w/a/note.md")).toBeNull();
			expect(result.current.getCachedContent("/w/a/note.md.bak")).toBe("bak-content");
			expect(tabPaths()).toEqual(["/w/a/note.md.bak"]);
		});

		it("active タブを rename した後も、未保存の編集が新 path の cache から取り出せる", async () => {
			diskContents.set("/w/a.md", "orig");
			seedWorkspace("/w", ["/w/a.md", "/w/c.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			expect(editor.getContent()).toBe("orig");

			editor.type("edited");

			await act(async () => {
				result.current.handleFileRenamed("/w/a.md", "/w/b.md", false);
			});
			await flushAsync();

			// 追跡 ref (prevTabPathRef / contentLoadedForPathRef) が新 path へ追随していないと、
			// この切替で「新 path の cache が作られない」か「disk から読み直した内容で
			// 上書きされる」ため、ユーザーの未保存編集が失われる。
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/c.md");
			});
			await flushAsync();

			expect(result.current.getCachedContent("/w/b.md")).toBe("edited");
			expect(result.current.getCachedContent("/w/a.md")).toBeNull();
		});

		it("active タブを含むディレクトリを rename した後も、未保存の編集が新 path の cache から取り出せる", async () => {
			diskContents.set("/w/a/foo/x.md", "orig");
			seedWorkspace("/w", ["/w/a/foo/x.md", "/w/c.md"], "/w/a/foo/x.md");
			const { result, editor } = renderManager();
			await flushAsync();
			expect(editor.getContent()).toBe("orig");

			editor.type("edited");

			await act(async () => {
				result.current.handleFileRenamed("/w/a/foo", "/w/a/baz", true);
			});
			await flushAsync();

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/c.md");
			});
			await flushAsync();

			expect(result.current.getCachedContent("/w/a/baz/x.md")).toBe("edited");
			expect(result.current.getCachedContent("/w/a/foo/x.md")).toBeNull();
		});

		it("rename 後に切り替えて戻っても、旧 path の cache が作り直されない", async () => {
			diskContents.set("/w/a.md", "orig");
			seedWorkspace("/w", ["/w/a.md", "/w/c.md"], "/w/a.md");
			const { result } = renderManager();
			await flushAsync();

			await act(async () => {
				result.current.handleFileRenamed("/w/a.md", "/w/b.md", false);
			});
			await flushAsync();
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/c.md");
			});
			await flushAsync();
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();

			expect(result.current.getCachedContent("/w/a.md")).toBeNull();
			// 進行中の autosave debounce を流し切ってからでも旧 path へは書かない。
			await advance(3000);
			expect(mockedWriteFile.mock.calls.map((c) => c[0])).not.toContain("/w/a.md");
		});
	});

	// #458 finding 4: handleCloseTab の分岐は元々 AppLayout に埋まっていて単体で試験できなかった。
	// 特に非 active タブの close は waitForPending → 再チェック → cache 直書き、という
	// 複数ステップの手続きなので、各分岐が正しい経路を通ることを個別に pin する。
	describe("handleCloseTab の分岐", () => {
		it("同一 id を連続 close しても writeFile と tab 消滅は 1 回分だけ起きる", async () => {
			diskContents.set("/w/a.md", "orig");
			seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited");

			// 1 回目の write を in-flight のまま止め、closingTabsRef ガードが
			// 2 回目の呼び出しを弾くこと (= write が 2 回走らないこと) を確認する。
			const deferred = createDeferred<void>();
			mockedWriteFile.mockImplementationOnce(() => deferred.promise);

			let p1!: Promise<void>;
			let p2!: Promise<void>;
			act(() => {
				p1 = result.current.handleCloseTab(1);
				p2 = result.current.handleCloseTab(1);
			});
			await flushAsync();

			expect(mockedWriteFile).toHaveBeenCalledTimes(1);
			// write 未解決の間は tab もまだ残っている
			expect(tabPaths()).toEqual(["/w/a.md"]);

			deferred.resolve();
			await Promise.all([p1, p2]);
			await flushAsync();

			expect(mockedWriteFile).toHaveBeenCalledTimes(1);
			expect(tabPaths()).toEqual([]);
		});

		it("存在しない tab id を渡しても何も起きない", async () => {
			diskContents.set("/w/a.md", "orig");
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }], "/w/a.md");
			const { result } = renderManager();
			await flushAsync();

			const before = tabPaths();
			await act(async () => {
				await result.current.handleCloseTab(999);
			});

			expect(tabPaths()).toEqual(before);
			expect(mockedWriteFile).not.toHaveBeenCalled();
		});

		it("newtab ページは保存せずに閉じる", async () => {
			diskContents.set("/w/other.md", "orig");
			seedWorkspace("/w", ["newtab://1", "/w/other.md"], "/w/other.md");
			const { result } = renderManager();
			await flushAsync();

			await act(async () => {
				await result.current.handleCloseTab(1);
			});

			expect(tabPaths()).toEqual(["/w/other.md"]);
			expect(mockedWriteFile).not.toHaveBeenCalled();
		});

		it("active タブは編集内容を保存してから閉じる", async () => {
			diskContents.set("/w/a.md", "orig");
			seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited");

			await act(async () => {
				await result.current.handleCloseTab(1);
			});

			// processContent により行末改行が付与された内容で保存される。
			expect(mockedWriteFile).toHaveBeenCalledWith("/w/a.md", "edited\n");
			expect(tabPaths()).toEqual([]);
		});

		it("active タブの保存が失敗したら閉じない", async () => {
			diskContents.set("/w/a.md", "orig");
			seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited");

			mockedWriteFile.mockRejectedValueOnce(new Error("boom"));

			await act(async () => {
				await result.current.handleCloseTab(1);
			});

			// saveIfDirty が false を返すので tab は store に残ったまま。
			expect(tabPaths()).toEqual(["/w/a.md"]);
		});

		it("waitForPending 中に対象タブが active 化すると、active 経路 (saveIfDirty) の分岐へ進む", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited-a");

			// A の flush write を in-flight のまま止める。
			const deferred = createDeferred<void>();
			mockedWriteFile.mockImplementationOnce(() => deferred.promise);
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();

			// 非 active な A の close を開始。waitForPending で flush write 完了待ちのはず。
			let closePromise!: Promise<void>;
			act(() => {
				closePromise = result.current.handleCloseTab(1);
			});
			await flushAsync();
			expect(tabPaths()).toContain("/w/a.md");

			// write 解決前に A を active 化する。
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/a.md");
			});
			await flushAsync();

			deferred.resolve();
			await closePromise;
			await flushAsync();

			// 再チェック (id === activeTabId) は「非 active cache への直書き」分岐を避けて
			// saveIfDirty 経路 (cached.content の直書きではなく getContent()/savedContentRef 比較)
			// へ進む。tab 自体は最終的に片付く。
			expect(tabPaths()).not.toContain("/w/a.md");
			expect(result.current.getCachedContent("/w/a.md")).toBeNull();

			// 1 回目は A→B 切替時の flush (A の編集内容が A へ書かれる = 正しい)。
			// 2 回目が現状の異常: 再チェック分岐は id === activeTabId を fresh な store state で
			// 判定する一方、そこから呼ぶ saveIfDirty / saveNow は handleCloseTab を呼んだ時点
			// (まだ B が active) のレンダーに束縛された closure で、useAutoSave の filePath も
			// "/w/b.md" のまま。結果として **A の内容が B の path へ書かれる**。
			// この test は現状の挙動を characterization として固定しているだけで、
			// 2 行目を「正しい」と主張してはいない (別 issue で追跡)。
			expect(mockedWriteFile.mock.calls).toEqual([
				["/w/a.md", "edited-a\n"],
				["/w/b.md", "edited-a\n"],
			]);
		});

		it("cache が無く store 上 dirty なタブは閉じない", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: true }, "/w/b.md"], "/w/b.md");
			const { result } = renderManager();
			await flushAsync();

			await act(async () => {
				await result.current.handleCloseTab(1);
			});

			expect(tabPaths()).toEqual(["/w/a.md", "/w/b.md"]);
			expect(mockedWriteFile).not.toHaveBeenCalled();
		});

		it("cache が無く store 上 clean なタブは保存せず閉じる", async () => {
			seedWorkspace("/w", [{ path: "/w/a.md", dirty: false }, "/w/b.md"], "/w/b.md");
			const { result } = renderManager();
			await flushAsync();

			await act(async () => {
				await result.current.handleCloseTab(1);
			});

			expect(tabPaths()).toEqual(["/w/b.md"]);
			expect(mockedWriteFile).not.toHaveBeenCalled();
		});

		it("非 active な dirty cache の write が成功すれば cache 内容を保存して閉じる", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited-a");

			mockedWriteFile.mockRejectedValueOnce(new Error("flush failed"));
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();
			expect(result.current.getCachedContent("/w/a.md")).toBe("edited-a");

			await act(async () => {
				await result.current.handleCloseTab(1);
			});

			// この経路は cache.content をそのまま書く (processContent を通さない)。
			expect(mockedWriteFile).toHaveBeenLastCalledWith("/w/a.md", "edited-a");
			expect(tabPaths()).toEqual(["/w/b.md"]);
		});

		it("非 active な dirty cache の write が失敗したら閉じない", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited-a");

			mockedWriteFile.mockRejectedValueOnce(new Error("flush failed"));
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();
			expect(result.current.getCachedContent("/w/a.md")).toBe("edited-a");

			mockedWriteFile.mockRejectedValueOnce(new Error("close write failed"));
			await act(async () => {
				await result.current.handleCloseTab(1);
			});

			expect(tabPaths()).toEqual(["/w/a.md", "/w/b.md"]);
			expect(result.current.getCachedContent("/w/a.md")).toBe("edited-a");
		});
	});

	// #458 finding 6: saveAllTabs (window close 前の一括保存) の分岐を pin する。
	describe("saveAllTabs の分岐", () => {
		it("active タブが dirty なら保存してから ok を返す", async () => {
			diskContents.set("/w/a.md", "orig");
			seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited");

			let saveResult!: "ok" | "failed" | "cancelled";
			await act(async () => {
				saveResult = await result.current.saveAllTabs();
			});

			expect(saveResult).toBe("ok");
			expect(mockedWriteFile).toHaveBeenCalledWith("/w/a.md", "edited\n");
		});

		it("active タブの保存が失敗したら failed を返す", async () => {
			diskContents.set("/w/a.md", "orig");
			seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited");

			mockedWriteFile.mockRejectedValueOnce(new Error("boom"));

			let saveResult!: "ok" | "failed" | "cancelled";
			await act(async () => {
				saveResult = await result.current.saveAllTabs();
			});

			expect(saveResult).toBe("failed");
		});

		it("複数 cache のうち 1 件だけ失敗すると failed を返し、成功分だけ clean になる", async () => {
			diskContents.set("/w/b.md", "orig-b");
			diskContents.set("/w/c.md", "orig-c");
			seedWorkspace("/w", ["/w/b.md", "/w/c.md", "newtab://1"], "/w/b.md");
			const { result, editor } = renderManager();
			await flushAsync();
			// 末尾改行済みの内容にしておく: processContent (trim + 末尾改行保証) を通しても
			// 値が変わらないので、write 成功後の cache.content === cache.savedContent 比較
			// (isCachedTabClean) が正規化の有無に左右されない。
			editor.type("edited-b\n");

			// B → C: B の flush を失敗させ dirty cache のまま残す
			mockedWriteFile.mockRejectedValueOnce(new Error("flush failed"));
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/c.md");
			});
			await flushAsync();
			editor.type("edited-c\n");

			// C → newtab: C の flush も失敗させる
			mockedWriteFile.mockRejectedValueOnce(new Error("flush failed"));
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("newtab://1");
			});
			await flushAsync();

			expect(result.current.getCachedContent("/w/b.md")).toBe("edited-b\n");
			expect(result.current.getCachedContent("/w/c.md")).toBe("edited-c\n");
			expect(result.current.isCachedTabClean("/w/b.md")).toBe(false);
			expect(result.current.isCachedTabClean("/w/c.md")).toBe(false);

			// saveAllTabs 内: B は成功、C は失敗させる (Map の挿入順 = B, C)
			mockedWriteFile.mockResolvedValueOnce(undefined);
			mockedWriteFile.mockRejectedValueOnce(new Error("save-all c failed"));

			let saveResult!: "ok" | "failed" | "cancelled";
			await act(async () => {
				saveResult = await result.current.saveAllTabs();
			});

			expect(saveResult).toBe("failed");
			expect(result.current.isCachedTabClean("/w/b.md")).toBe(true);
			expect(result.current.isCachedTabClean("/w/c.md")).toBe(false);
			const tabs = useWorkspaceStore.getState().tabs;
			expect(tabs.find((t) => t.path === "/w/b.md")?.dirty).toBe(false);
			expect(tabs.find((t) => t.path === "/w/c.md")?.dirty).toBe(true);
		});

		it("newtab ページと clean な cache は write 対象から除外される", async () => {
			seedWorkspace("/w", ["newtab://1", "/w/clean.md"], "newtab://1");
			const { result } = renderManager();
			await flushAsync();

			act(() => {
				result.current.applyCacheReload("/w/clean.md", "clean-content");
			});

			let saveResult!: "ok" | "failed" | "cancelled";
			await act(async () => {
				saveResult = await result.current.saveAllTabs();
			});

			expect(saveResult).toBe("ok");
			expect(mockedWriteFile).not.toHaveBeenCalled();
		});

		it("dirty cache は trimTrailingWhitespace 設定に従って正規化されてから write される", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("line   ");

			mockedWriteFile.mockRejectedValueOnce(new Error("flush failed"));
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();
			expect(result.current.getCachedContent("/w/a.md")).toBe("line   ");

			mockedWriteFile.mockResolvedValueOnce(undefined);
			await act(async () => {
				await result.current.saveAllTabs();
			});

			// trimTrailingWhitespace: true (既定) → 行末空白除去 + 末尾改行
			expect(mockedWriteFile).toHaveBeenLastCalledWith("/w/a.md", "line\n");
		});

		it("trimTrailingWhitespace: false のときは行末空白を残したまま write される", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("line   ");

			mockedWriteFile.mockRejectedValueOnce(new Error("flush failed"));
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();
			expect(result.current.getCachedContent("/w/a.md")).toBe("line   ");

			useSettingsStore.setState({ trimTrailingWhitespace: false });
			mockedWriteFile.mockResolvedValueOnce(undefined);
			await act(async () => {
				await result.current.saveAllTabs();
			});

			expect(mockedWriteFile).toHaveBeenLastCalledWith("/w/a.md", "line   \n");
		});

		it("await 中に unmount したら cancelled を返し、store を更新しない", async () => {
			diskContents.set("/w/a.md", "orig");
			seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
			const { result, editor, unmount } = renderManager();
			await flushAsync();
			editor.type("edited");

			const deferred = createDeferred<void>();
			mockedWriteFile.mockImplementationOnce(() => deferred.promise);

			let saveResult!: "ok" | "failed" | "cancelled";
			let savePromise!: Promise<void>;
			act(() => {
				savePromise = result.current.saveAllTabs().then((r) => {
					saveResult = r;
				});
			});
			await flushAsync();

			const dirtyBefore = useWorkspaceStore
				.getState()
				.tabs.find((t) => t.path === "/w/a.md")?.dirty;

			unmount();
			deferred.resolve();
			await savePromise;
			await flushAsync();

			expect(saveResult).toBe("cancelled");
			// unmount 後は setTabDirty が呼ばれないので dirty 状態は変化しない。
			expect(useWorkspaceStore.getState().tabs.find((t) => t.path === "/w/a.md")?.dirty).toBe(
				dirtyBefore,
			);
		});
	});

	/** store 上の dirty フラグを path 指定で読む。 */
	function tabDirty(path: string): boolean | undefined {
		return useWorkspaceStore.getState().tabs.find((t) => t.path === path)?.dirty;
	}

	// #458 finding 3: handleFlushComplete の dirty 判定。flush はタブ切替時の非同期 write なので、
	// 完了時点で「flush 対象が再び active に戻り、かつさらに編集されていた」場合に
	// ユーザーの追加編集を保存済み扱いにしてしまわないかを pin する
	// (1 本目は実装の実際の挙動が想定と異なった characterization test、詳細はテスト内コメント参照)。
	describe("handleFlushComplete の dirty 判定", () => {
		it("flush 解決前に active タブへ戻ってさらに編集すると dirty が落ち、その窓の window close で編集が保存されない (characterization)", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { editor, result } = renderManager();
			await flushAsync();
			editor.type("edited-a");

			// A → B の切替で走る flush write を in-flight のまま止める。
			const deferred = createDeferred<void>();
			mockedWriteFile.mockImplementationOnce(() => deferred.promise);
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();

			// flush 解決前に A へ戻り、さらに編集する。
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/a.md");
			});
			await flushAsync();
			editor.type("edited-a-more");
			// 実アプリでは MarkdownEditor の onDocChanged が scheduleAutoSave を呼ぶ。
			// この配線を入れないと「編集したのに saveStatus が unsaved にならない」
			// harness 固有の状態になり、dirty 判定の pin が実挙動から乖離する。
			act(() => {
				result.current.scheduleAutoSave();
			});
			expect(tabDirty("/w/a.md")).toBe(true);

			deferred.resolve();
			await flushAsync();

			// handleFlushComplete (useTabContentManager.ts:188-190) は
			// `currentActive === path && getContent() !== rawContent` のとき dirty を
			// 落とさずに return する — が、その直後に useAutoSave が setSaveStatus("saved")
			// を呼ぶ (useAutoSave.ts:221)。これを受けた「Sync dirty flag to store」effect
			// (useTabContentManager.ts:370-374) が saveStatus だけを見て dirty=false を
			// 書き戻すため、早期 return の意図は打ち消される。
			expect(tabDirty("/w/a.md")).toBe(false);

			// 影響は dirty 表示だけに留まらない。同じ flush 完了で「Keep savedContent」effect
			// (useTabContentManager.ts:347-365) が savedContentRef と cache の savedContent を
			// 未保存の内容へ進めるため、この窓で window close すると saveAllTabs は
			// `getContent() !== savedContentRef.current` が false で **active タブを skip** し、
			// その編集を保存しないまま "ok" を返す (他に dirty な cache タブがあればそちらは
			// 書かれる。失われるのは active タブの編集)。
			const writesBeforeClose = mockedWriteFile.mock.calls.length;
			let closeResult!: "ok" | "failed" | "cancelled";
			await act(async () => {
				closeResult = await result.current.saveAllTabs();
			});
			expect(closeResult).toBe("ok");
			expect(mockedWriteFile.mock.calls.length).toBe(writesBeforeClose);

			// 窓を抜ければ保留中の debounce autosave が書き切る。失われるのは
			// 「flush 完了から debounce 発火までの間に window close した場合」だけ。
			await advance(2000);
			expect(mockedWriteFile).toHaveBeenLastCalledWith("/w/a.md", "edited-a-more\n");
		});

		it("flush 後に追加編集が無ければ dirty が落ちる", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { editor } = renderManager();
			await flushAsync();
			editor.type("edited-a");

			const deferred = createDeferred<void>();
			mockedWriteFile.mockImplementationOnce(() => deferred.promise);
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/a.md");
			});
			await flushAsync();

			deferred.resolve();
			await flushAsync();

			expect(tabDirty("/w/a.md")).toBe(false);
		});

		it("flush 対象が現在の active タブでない場合も dirty が落ちる", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { editor } = renderManager();
			await flushAsync();
			editor.type("edited-a");

			const deferred = createDeferred<void>();
			mockedWriteFile.mockImplementationOnce(() => deferred.promise);
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();

			// B が active のまま A の flush が解決する。
			deferred.resolve();
			await flushAsync();

			expect(tabDirty("/w/a.md")).toBe(false);
		});
	});

	// #458 finding 7: 公開 cache / reload API (getCachedContent / isCachedTabClean /
	// applyExternalReload / applyCacheReload / applyConflictReload / dropTab)。
	// tabCacheRef は非公開表現なので、ここでも公開 API の戻り値だけで観測する。
	describe("公開 cache / reload API", () => {
		it("getCachedContent は active タブでは編集直後の live editor 内容を返す", async () => {
			diskContents.set("/w/a.md", "orig");
			seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();

			editor.type("edited-live");

			// cache へ確定するのはタブ切替時 (#302)。それ以前でも active タブは editor から
			// 直接読む契約になっているはずで、そうでないと編集直後の内容が失われて見える。
			expect(result.current.getCachedContent("/w/a.md")).toBe("edited-live");
		});

		it("getCachedContent は非 active タブで cache が無ければ null、あれば cache の内容を返す", async () => {
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/b.md");
			const { result } = renderManager();
			await flushAsync();

			expect(result.current.getCachedContent("/w/a.md")).toBeNull();

			act(() => {
				result.current.applyCacheReload("/w/a.md", "cached-content");
			});

			expect(result.current.getCachedContent("/w/a.md")).toBe("cached-content");
		});

		it("isCachedTabClean は cache が無ければ false を返す (fail-closed)", async () => {
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/b.md");
			const { result } = renderManager();
			await flushAsync();

			// 「clean だから安全に上書きしてよい」と誤読されないよう、未知の path は
			// dirty 扱い (false) が既定でなければならない。
			expect(result.current.isCachedTabClean("/w/a.md")).toBe(false);
		});

		it("isCachedTabClean は clean cache で true、dirty cache で false", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited-a");

			mockedWriteFile.mockRejectedValueOnce(new Error("flush failed"));
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();

			// flush 失敗で A の cache は dirty のまま残る。
			expect(result.current.isCachedTabClean("/w/a.md")).toBe(false);

			act(() => {
				result.current.applyCacheReload("/w/c.md", "clean-content");
			});
			expect(result.current.isCachedTabClean("/w/c.md")).toBe(true);
		});

		it("applyExternalReload は自分の write と一致する内容なら no-op", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited-a");

			await act(async () => {
				await result.current.saveNow();
			});
			await flushAsync();

			const lastSaved = result.current.getLastSavedContent();
			const beforeDoc = editor.getContent();

			act(() => {
				result.current.applyExternalReload("/w/a.md", lastSaved);
			});

			// 自分の write を外部変更と誤認して remount すると、doc は同じ内容でも
			// undo 履歴が失われる (editorKey bump)。ここで assert するのは doc が
			// 置き換わらないこと。cache 側は active タブの getCachedContent が live editor を
			// 返す仕様上ここからは観測できない (cache エントリ自体は作られる)。
			expect(editor.getContent()).toBe(beforeDoc);
			expect(result.current.getCachedContent("/w/a.md")).toBe(beforeDoc);
		});

		it("applyExternalReload は内容が異なれば active タブの表示を更新する", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();

			act(() => {
				result.current.applyExternalReload("/w/a.md", "external-content");
			});

			expect(editor.getContent()).toBe("external-content");
			expect(result.current.getCachedContent("/w/a.md")).toBe("external-content");
		});

		it("applyExternalReload は対象が active でなければ cache だけ更新して editor を触らない", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/b.md");
			const { result, editor } = renderManager();
			await flushAsync();
			const beforeDoc = editor.getContent();

			act(() => {
				result.current.applyExternalReload("/w/a.md", "external-content");
			});

			// readFile 解決を待つ間に非 active タブが active 化していても、
			// 今表示中の (別タブの) 画面を勝手に書き換えてはいけない。
			expect(editor.getContent()).toBe(beforeDoc);
			expect(result.current.getCachedContent("/w/a.md")).toBe("external-content");
		});

		it("applyCacheReload は整形後の内容が cache と一致するなら cache を置き換えない", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("line   ");

			mockedWriteFile.mockRejectedValueOnce(new Error("flush failed"));
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();
			expect(result.current.getCachedContent("/w/a.md")).toBe("line   ");

			// 自分の write が processContent 適用後に一致する内容を外部変更として渡しても、
			// 未保存編集 (末尾空白付きの生の doc) を disk 正規化後の内容で上書きしてはいけない。
			act(() => {
				result.current.applyCacheReload("/w/a.md", "line\n");
			});

			expect(result.current.getCachedContent("/w/a.md")).toBe("line   ");
		});

		it("applyConflictReload は active タブで cache と editor の両方を置き換え dirty を落とす", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited-a");

			act(() => {
				result.current.applyConflictReload("/w/a.md", "conflict-resolved");
			});

			expect(editor.getContent()).toBe("conflict-resolved");
			expect(result.current.getCachedContent("/w/a.md")).toBe("conflict-resolved");
			expect(tabDirty("/w/a.md")).toBe(false);
		});

		it("applyConflictReload は非 active タブでも cache を置き換え dirty を落とす", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited-a");

			mockedWriteFile.mockRejectedValueOnce(new Error("flush failed"));
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();
			const bEditorDoc = editor.getContent();

			act(() => {
				result.current.applyConflictReload("/w/a.md", "conflict-resolved");
			});

			expect(result.current.getCachedContent("/w/a.md")).toBe("conflict-resolved");
			expect(tabDirty("/w/a.md")).toBe(false);
			// 非 active な A への適用が、今表示中の B の editor を書き換えてはいけない。
			expect(editor.getContent()).toBe(bEditorDoc);
		});

		it("dropTab は cache だけ捨てタブは閉じない", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/b.md");
			const { result } = renderManager();
			await flushAsync();

			act(() => {
				result.current.applyCacheReload("/w/a.md", "cached-content");
			});
			expect(result.current.getCachedContent("/w/a.md")).toBe("cached-content");

			act(() => {
				result.current.dropTab("/w/a.md");
			});

			expect(result.current.getCachedContent("/w/a.md")).toBeNull();
			expect(tabPaths()).toEqual(["/w/a.md", "/w/b.md"]);
		});
	});
});
