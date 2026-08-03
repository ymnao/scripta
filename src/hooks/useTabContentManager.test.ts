import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	advance,
	createDeferred,
	createFakeEditor,
	type Deferred,
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
		// よる remount と restoreSnapshot のときだけ。fake もその境界に合わせる (合わせないと
		// 「ロードし直したはずの内容」が編集内容のまま残り、cache の assert が実挙動から乖離する)。
		//
		// epoch bump は remount ではない: restoreSnapshot が成功したとき view identity は
		// 同じまま内部 state だけが置換される。ここで epoch も remount のトリガに含めると
		// 「restore が doc を戻した」のか「remount が loadedDoc を入れ直した」のかを
		// 区別できなくなるので、restore 経路の doc 置換は fake handle 自身に行わせる。
		const remountTokenRef = useRef<number | null>(null);
		if (remountTokenRef.current !== manager.editorKey) {
			remountTokenRef.current = manager.editorKey;
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

		it("未保存の編集がある active タブを rename しても、旧 path へ書き戻さない", async () => {
			// rename を「別ファイルへの切替」と誤認して flush write すると、main 側は
			// 書き込み先の親ディレクトリを作り直すため、rename で消えたはずの path が
			// disk 上にゴーストとして復活する。
			diskContents.set("/w/a.md", "orig");
			seedWorkspace("/w", ["/w/a.md", "/w/c.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited");
			// 実アプリの onDocChanged 相当。rename 前に旧 path 向けの debounce が
			// 予約された状態を作る (予約を残したまま rename すると、その timer が
			// 旧 path の closure のまま発火してゴーストを作る)。
			act(() => {
				result.current.scheduleAutoSave();
			});

			await act(async () => {
				result.current.handleFileRenamed("/w/a.md", "/w/b.md", false);
			});
			await flushAsync();
			await advance(3000);

			expect(mockedWriteFile.mock.calls.map((c) => c[0])).not.toContain("/w/a.md");
			// 編集自体は新 path へ保存される (書かないのではなく、書き先が変わる)。
			expect(mockedWriteFile).toHaveBeenLastCalledWith("/w/b.md", "edited\n");
		});

		it("未保存の編集がある active タブのディレクトリを rename しても、旧 path へ書き戻さない", async () => {
			diskContents.set("/w/a/foo/x.md", "orig");
			seedWorkspace("/w", ["/w/a/foo/x.md", "/w/c.md"], "/w/a/foo/x.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited");

			await act(async () => {
				result.current.handleFileRenamed("/w/a/foo", "/w/a/baz", true);
			});
			await flushAsync();
			await advance(3000);

			expect(mockedWriteFile.mock.calls.map((c) => c[0])).not.toContain("/w/a/foo/x.md");
			expect(mockedWriteFile).toHaveBeenLastCalledWith("/w/a/baz/x.md", "edited\n");
		});

		it("rename 中に旧 path の readFile が遅れて解決しても、新 path のロード結果を上書きしない", async () => {
			// 旧 path の read は effect cleanup の ignore フラグで破棄されるはず。
			// 破棄が効かないと、rename 後のエディタに旧 path の内容が現れ、
			// そのまま新 path へ保存されて中身がすり替わる。
			const oldRead = createDeferred<string>();
			mockedReadFile.mockImplementation((path: string) => {
				if (path === "/w/a/foo/x.md") return oldRead.promise;
				return Promise.resolve(diskContents.get(path) ?? `disk:${path}`);
			});
			diskContents.set("/w/a/baz/x.md", "new-path-content");
			seedWorkspace("/w", ["/w/a/foo/x.md"], "/w/a/foo/x.md");
			const { result, editor } = renderManager();
			await flushAsync();

			await act(async () => {
				result.current.handleFileRenamed("/w/a/foo", "/w/a/baz", true);
			});
			await flushAsync();
			expect(editor.getContent()).toBe("new-path-content");

			await act(async () => {
				oldRead.resolve("stale-old-content");
			});
			await flushAsync();

			expect(editor.getContent()).toBe("new-path-content");
			expect(result.current.getCachedContent("/w/a/baz/x.md")).toBe("new-path-content");
		});

		it("rename 対象の prefix 外に居る active タブは、追跡 ref を書き換えられない", async () => {
			// 追跡 ref の追随を prefix 判定なしで無条件に行うと、rename と無関係な
			// active タブの ref が別 path へ飛ばされ、そのタブの未保存編集が
			// 「存在しない path の cache」に落ちて失われる。
			diskContents.set("/w/a/foobar/y.md", "orig-y");
			seedWorkspace("/w", ["/w/a/foobar/y.md", "/w/c.md"], "/w/a/foobar/y.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited-y");

			await act(async () => {
				result.current.handleFileRenamed("/w/a/foo", "/w/a/baz", true);
			});
			await flushAsync();

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/c.md");
			});
			await flushAsync();

			expect(result.current.getCachedContent("/w/a/foobar/y.md")).toBe("edited-y");
			expect(result.current.getCachedContent("/w/a/bazbar/y.md")).toBeNull();
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

			// 1 回目は A→B 切替時の flush、2 回目は再チェック分岐からの保存。
			// **どちらも A の path へ向かねばならない**。再チェックは
			// id === activeTabId を fresh な store state で判定するのに、そこから呼ぶ
			// saveIfDirty / saveNow を呼び出し時のレンダーに束縛された closure のままに
			// すると、useAutoSave の filePath が "/w/b.md" のままになり
			// **A の内容が B の path へ書かれて B の中身がすり替わる**。
			expect(mockedWriteFile.mock.calls).toEqual([
				["/w/a.md", "edited-a\n"],
				["/w/a.md", "edited-a\n"],
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
	// 完了時点でユーザーの追加編集を保存済み扱いにしてしまわないことを pin する。
	describe("handleFlushComplete の dirty 判定", () => {
		it("flush 解決前に active タブへ戻ってさらに編集した場合、dirty を維持し window close でその編集を保存する", async () => {
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

			// handleFlushComplete (useTabContentManager.ts) は追加編集がある active タブの
			// dirty を落とさずに return するが、flush 完了時に useAutoSave が無条件に
			// setSaveStatus("saved") を呼ぶと「Sync dirty flag to store」effect が
			// saveStatus だけを見て dirty=false に書き戻し、早期 return の意図が消える。
			expect(tabDirty("/w/a.md")).toBe(true);

			// dirty 表示だけの問題ではない。saveStatus が "saved" になると
			// 「Keep savedContent」effect が savedContentRef を未保存の内容へ進めてしまい、
			// window close 時の saveAllTabs が `getContent() !== savedContentRef.current`
			// を false と判定して active タブを skip する = 編集が保存されないまま閉じる。
			await act(async () => {
				expect(await result.current.saveAllTabs()).toBe("ok");
			});
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
			const beforeKey = result.current.editorKey;

			act(() => {
				result.current.applyExternalReload("/w/a.md", lastSaved);
			});

			// 自分の write を外部変更と誤認して remount すると、doc は同じ内容でも
			// undo 履歴が失われる。内容が一致している以上 doc の比較では remount を
			// 検出できないので、**editorKey が bump していないこと**を直接見る。
			expect(result.current.editorKey).toBe(beforeKey);
			expect(editor.getContent()).toBe(beforeDoc);
			// cache 側は active タブの getCachedContent が live editor を返す仕様上
			// ここからは観測できない (cache エントリ自体は作られる)。
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

	// #458 finding 1: タブ切替・ロード effect。activeTabPath / workspacePath が変わるたびに
	// 「前タブの退避 → 新タブの内容決定」を 1 つの effect でやっており、どの分岐を通るかで
	// 画面に出る内容と savedContent の追跡先が変わる。取り違えると別ファイルの内容を
	// 表示したまま保存する経路になるので、分岐ごとに個別に pin する。
	describe("タブ切替・ロード effect の分岐", () => {
		it("activeTabPath が null になると loadedDoc が空になり、disk 読み込みも走らない", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md"], "/w/a.md");
			const { result } = renderManager();
			await flushAsync();
			expect(result.current.loadedDoc).toBe("orig-a");

			mockedReadFile.mockClear();
			await act(async () => {
				useWorkspaceStore.setState({ activeTabPath: null, activeTabId: null });
			});
			await flushAsync();

			// 実 AppLayout はこの状態で MarkdownEditor 自体を unmount するので、観測するのは
			// editor の doc ではなく hook が下流へ渡す loadedDoc。空に戻さないと、次に開いた
			// ファイルの初期表示に前タブの内容が残る。
			expect(result.current.loadedDoc).toBe("");
			expect(mockedReadFile).not.toHaveBeenCalled();
		});

		it("newtab ページへ切り替えると disk を読まず loadedDoc が空になる", async () => {
			diskContents.set("/w/a.md", "orig-a");
			seedWorkspace("/w", ["/w/a.md", "newtab://1"], "/w/a.md");
			const { result } = renderManager();
			await flushAsync();

			mockedReadFile.mockClear();
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("newtab://1");
			});
			await flushAsync();

			// newtab:// は disk 上のファイルではない。読みに行くと存在しないパスの
			// エラーが出るうえ、error 分岐が editorError を立てて新規タブ画面を壊す。
			expect(result.current.isNewTab).toBe(true);
			expect(result.current.loadedDoc).toBe("");
			expect(mockedReadFile).not.toHaveBeenCalled();
		});

		it("disk 読み込みに失敗すると editorError が立ち、次のタブ切替でクリアされる", async () => {
			diskContents.set("/w/b.md", "orig-b");
			seedWorkspace("/w", ["/w/bad.md", "/w/b.md"], "/w/bad.md");
			mockedReadFile.mockRejectedValueOnce(new Error("boom"));
			const { result } = renderManager();
			await flushAsync();

			// 失敗したのに前の内容を残すと、ユーザーはそれを「このファイルの中身」と
			// 見なして編集し、保存で別ファイルの内容を書き込むことになる。
			expect(result.current.editorError).not.toBeNull();
			expect(result.current.loadedDoc).toBe("");

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();

			expect(result.current.editorError).toBeNull();
			expect(result.current.loadedDoc).toBe("orig-b");
		});

		/**
		 * 発行済みの readFile を取り出す。未発行なら test を落とす。optional chaining で
		 * 黙って no-op になると、cleanup の ignore 分岐を一度も通らないまま緑になる。
		 */
		function takeDeferred(pending: Map<string, Deferred<string>>, path: string): Deferred<string> {
			const deferred = pending.get(path);
			if (!deferred) throw new Error(`readFile が未発行: ${path}`);
			return deferred;
		}

		it("読み込み中に別タブへ切り替えると、遅れて解決した前タブの内容で画面を汚さない", async () => {
			const pending = new Map<string, Deferred<string>>();
			mockedReadFile.mockImplementation((path: string) => {
				const deferred = createDeferred<string>();
				pending.set(path, deferred);
				return deferred.promise;
			});
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();

			// A の read を未解決のまま B へ切り替える (effect cleanup で A 側に ignore が立つ)。
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();
			await act(async () => {
				takeDeferred(pending, "/w/b.md").resolve("b-content");
			});
			await flushAsync();
			expect(editor.getContent()).toBe("b-content");
			const keyAfterB = result.current.editorKey;

			await act(async () => {
				takeDeferred(pending, "/w/a.md").resolve("stale-a-content");
			});
			await flushAsync();

			// ignore を無視すると B を見ている画面が A の内容に差し替わり、そのまま
			// B の path へ保存されて B の中身がすり替わる。
			expect(editor.getContent()).toBe("b-content");
			expect(result.current.editorKey).toBe(keyAfterB);
			expect(result.current.getCachedContent("/w/a.md")).toBeNull();
		});

		it("読み込み中に別タブへ切り替えると、遅れて失敗した前タブのエラーを表示しない", async () => {
			const pending = new Map<string, Deferred<string>>();
			mockedReadFile.mockImplementation((path: string) => {
				const deferred = createDeferred<string>();
				pending.set(path, deferred);
				return deferred.promise;
			});
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();
			await act(async () => {
				takeDeferred(pending, "/w/b.md").resolve("b-content");
			});
			await flushAsync();

			await act(async () => {
				takeDeferred(pending, "/w/a.md").reject(new Error("boom"));
			});
			await flushAsync();

			// catch 側の ignore を落とすと、今開いているタブは正常に読めているのに
			// 別タブ由来のエラーバナーが出て、loadedDoc まで空へ巻き戻される。
			expect(result.current.editorError).toBeNull();
			expect(editor.getContent()).toBe("b-content");
		});

		it("workspace を切り替えると cache が破棄され、切替元のタブも cache に保存されない", async () => {
			diskContents.set("/w1/a.md", "orig-a");
			diskContents.set("/w1/b.md", "orig-b");
			seedWorkspace("/w1", ["/w1/a.md", "/w1/b.md"], "/w1/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited-a");

			mockedWriteFile.mockRejectedValueOnce(new Error("flush failed"));
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w1/b.md");
			});
			await flushAsync();
			expect(result.current.getCachedContent("/w1/a.md")).toBe("edited-a");

			// 新 workspace の tabs に切替元 (/w1/b.md) と同じ path を残しておく。残さないと
			// tabStillExists が false になり、!workspaceChanged ガードを外しても cache が
			// 作られない (= 「保存しない」性質を pin できず mutant が survive する)。
			await act(async () => {
				seedWorkspace("/w2", ["/w1/b.md", "/w2/x.md"], "/w2/x.md");
			});
			await flushAsync();

			// 旧 workspace の cache を持ち越すと、別 workspace の同名パスに旧内容を
			// 書き戻す経路になる。切替元タブの退避も旧 workspace 側の内容なので行わない。
			expect(result.current.getCachedContent("/w1/a.md")).toBeNull();
			expect(result.current.getCachedContent("/w1/b.md")).toBeNull();
		});

		it("workspace 切替後に作った cache は、次のタブ切替では破棄されない", async () => {
			seedWorkspace("/w1", ["/w1/a.md"], "/w1/a.md");
			const { result } = renderManager();
			await flushAsync();

			await act(async () => {
				seedWorkspace("/w2", ["/w2/x.md", "/w2/y.md"], "/w2/x.md");
			});
			await flushAsync();

			act(() => {
				result.current.applyCacheReload("/w2/z.md", "z-content");
			});

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w2/y.md");
			});
			await flushAsync();

			// prevWorkspacePathRef を更新し損ねると毎回 workspaceChanged が true になり、
			// タブを切り替えるたびに全 cache が消えて未保存の編集が失われる。
			expect(result.current.getCachedContent("/w2/z.md")).toBe("z-content");
		});

		it("保留していた go-to-line は disk 読み込み成功後に適用され、以降は再発火しない", async () => {
			diskContents.set("/w/a.md", "orig-a");
			diskContents.set("/w/b.md", "orig-b");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, onGoToLine } = renderManager();
			await flushAsync();

			act(() => {
				result.current.queueGoToLine({ line: 5 });
			});
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();

			// 読み込み前に飛ばすと行が存在せず、検索結果からのジャンプが黙って無効になる。
			expect(onGoToLine).toHaveBeenCalledWith({ line: 5 });

			onGoToLine.mockClear();
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/a.md");
			});
			await flushAsync();

			// 適用したら消費する。残すと無関係なタブでカーソルが勝手に飛ぶ。
			expect(onGoToLine).not.toHaveBeenCalled();
		});

		it("保留していた go-to-line は cache hit のタブ切替でも適用される", async () => {
			diskContents.set("/w/a.md", "orig-a");
			diskContents.set("/w/b.md", "orig-b");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, onGoToLine } = renderManager();
			await flushAsync();

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();

			act(() => {
				result.current.queueGoToLine({ line: 7 });
			});
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/a.md");
			});
			await flushAsync();

			// 適用は cache hit / disk 読み込みの 2 箇所に分かれて書かれている。片方だけ
			// pin してももう片方の退行を検出できないので、両方 pin する。
			expect(onGoToLine).toHaveBeenCalledWith({ line: 7 });
		});

		it("読み込みに失敗したタブでは go-to-line を適用せず、その後のタブ切替にも持ち越さない", async () => {
			diskContents.set("/w/a.md", "orig-a");
			diskContents.set("/w/b.md", "orig-b");
			seedWorkspace("/w", ["/w/a.md", "/w/bad.md", "/w/b.md"], "/w/a.md");
			const { result, onGoToLine } = renderManager();
			await flushAsync();

			act(() => {
				result.current.queueGoToLine({ line: 9 });
			});
			mockedReadFile.mockRejectedValueOnce(new Error("boom"));
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/bad.md");
			});
			await flushAsync();

			expect(onGoToLine).not.toHaveBeenCalled();

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();

			// 破棄し損ねると、読めなかったファイル向けの行番号が次に開いた別ファイルへ
			// 適用される (pendingGoToLineRef は非公開なので、この持ち越しでしか観測できない)。
			expect(onGoToLine).not.toHaveBeenCalled();
		});
	});

	// #458 finding 2: cache 復元時の snapshot 分岐。restoreSnapshot が成功したかどうかで
	// 「view の内部 state 差し替え (epoch bump)」と「remount (editorKey bump)」に分かれ、
	// 前者でしか undo 履歴とカーソル位置が戻らない。fallback が壊れると復帰したタブが
	// 白紙になるので、成功・失敗の両側を pin する。
	describe("cache 復元の snapshot 分岐", () => {
		it("タブ切替で捕った snapshot が復帰時に restoreSnapshot へ渡り、editorViewEpoch だけが進む", async () => {
			diskContents.set("/w/a.md", "orig-a");
			diskContents.set("/w/b.md", "orig-b");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();

			const handle = editor.createSnapshotHandle();
			result.current.markdownEditorHandleRef.current = handle;
			editor.type("edited-a");

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();
			expect(handle.captureSnapshot).toHaveBeenCalledTimes(1);
			const capturedToken = handle.captureSnapshot.mock.results[0]?.value;
			expect(capturedToken).not.toBeNull();

			const keyBefore = result.current.editorKey;
			const epochBefore = result.current.editorViewEpoch;
			const remountsBefore = editor.getRemountCount();

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/a.md");
			});
			await flushAsync();

			// 復元に渡すのは A を離れるときに捕った snapshot そのもの (同一参照)。
			// 構造だけ似た別 object を渡すと undo 履歴が復元されない。
			expect(handle.restoreSnapshot).toHaveBeenCalledTimes(1);
			expect(handle.restoreSnapshot.mock.lastCall?.[0]).toBe(capturedToken);
			// epoch と key は「どちらが進んだか」に意味がある。key を進めると remount に
			// なって履歴が飛び、epoch を進めないと view を deps に持つ下流が再走しない。
			expect(result.current.editorViewEpoch).toBe(epochBefore + 1);
			expect(result.current.editorKey).toBe(keyBefore);
			// doc の値では restore と remount を区別できない (復元内容と loadedDoc は
			// 常に一致する)。remount が走っていないことを経路として観測する。
			expect(editor.getRemountCount()).toBe(remountsBefore);
			expect(editor.getContent()).toBe("edited-a");
		});

		it("snapshot handle が無ければ editorKey bump で remount して cache の内容を表示する", async () => {
			diskContents.set("/w/a.md", "orig-a");
			diskContents.set("/w/b.md", "orig-b");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();
			editor.type("edited-a");

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();
			const keyBefore = result.current.editorKey;
			const remountsBefore = editor.getRemountCount();

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/a.md");
			});
			await flushAsync();

			// SlideView 表示中など MarkdownEditor が mount されていない場合の経路。
			// fallback が効かないと復帰したタブに内容が入らない。
			expect(result.current.editorViewEpoch).toBe(0);
			expect(result.current.editorKey).toBe(keyBefore + 1);
			expect(editor.getRemountCount()).toBe(remountsBefore + 1);
			expect(editor.getContent()).toBe("edited-a");
		});

		it("snapshot を持たない cache では restoreSnapshot を呼ばず editorKey fallback する", async () => {
			diskContents.set("/w/b.md", "orig-b");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/b.md");
			const { result, editor } = renderManager();
			await flushAsync();

			const handle = editor.createSnapshotHandle();
			result.current.markdownEditorHandleRef.current = handle;
			// 外部リロード由来の cache には snapshot が無い (doc とズレるため破棄される)。
			act(() => {
				result.current.applyCacheReload("/w/a.md", "cached-a");
			});

			const keyBefore = result.current.editorKey;
			const epochBefore = result.current.editorViewEpoch;

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/a.md");
			});
			await flushAsync();

			// snapshot が無いのに restore を呼ぶと、実物は不正な引数で false を返すだけだが
			// 「呼ばない」ことが cache 破棄の契約 (doc とズレた履歴を戻さない) の担保になる。
			expect(handle.restoreSnapshot).not.toHaveBeenCalled();
			expect(result.current.editorViewEpoch).toBe(epochBefore);
			expect(result.current.editorKey).toBe(keyBefore + 1);
			expect(editor.getContent()).toBe("cached-a");
		});

		it("restoreSnapshot が失敗したら editorKey fallback で cache の内容を表示する", async () => {
			diskContents.set("/w/a.md", "orig-a");
			diskContents.set("/w/b.md", "orig-b");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();

			const handle = editor.createSnapshotHandle();
			result.current.markdownEditorHandleRef.current = handle;
			editor.type("edited-a");

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();

			const capturedToken = handle.captureSnapshot.mock.results[0]?.value;
			expect(capturedToken).not.toBeNull();

			// EditorState.fromJSON が壊れた snapshot で throw するケース。
			handle.restoreFails = true;
			const keyBefore = result.current.editorKey;
			const epochBefore = result.current.editorViewEpoch;
			const remountsBefore = editor.getRemountCount();

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/a.md");
			});
			await flushAsync();

			// restore を呼んだうえで false が返ったこと。呼び出し自体を pin しないと、
			// snapshot 復元を丸ごと諦める実装 (常に remount) でもこの test が通ってしまう。
			expect(handle.restoreSnapshot).toHaveBeenCalledTimes(1);
			expect(handle.restoreSnapshot.mock.lastCall?.[0]).toBe(capturedToken);
			// false を成功扱いすると epoch だけ進んで doc が入らず、復帰したタブが白紙になる。
			expect(result.current.editorViewEpoch).toBe(epochBefore);
			expect(result.current.editorKey).toBe(keyBefore + 1);
			expect(editor.getRemountCount()).toBe(remountsBefore + 1);
			expect(editor.getContent()).toBe("edited-a");
		});

		it("captureSnapshot が null を返しても、既に持っている snapshot を捨てない", async () => {
			diskContents.set("/w/a.md", "orig-a");
			diskContents.set("/w/b.md", "orig-b");
			seedWorkspace("/w", ["/w/a.md", "/w/b.md"], "/w/a.md");
			const { result, editor } = renderManager();
			await flushAsync();

			const handle = editor.createSnapshotHandle();
			result.current.markdownEditorHandleRef.current = handle;
			editor.type("edited-a");

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();
			const firstToken = handle.captureSnapshot.mock.results[0]?.value;
			expect(firstToken).not.toBeNull();

			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/a.md");
			});
			await flushAsync();

			// MarkdownEditor が mount されていない瞬間の切替を模す。
			handle.captureReturnsNull = true;
			const capturesBeforeNull = handle.captureSnapshot.mock.calls.length;
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/b.md");
			});
			await flushAsync();
			await act(async () => {
				useWorkspaceStore.getState().setActiveTab("/w/a.md");
			});
			await flushAsync();

			// null で上書きすると次の復帰で snapshot 無し扱いになり、カーソル位置と
			// undo 履歴が全損する。観測は「同じ token がもう一度 restore に渡ること」で行う
			// (doc で観測すると、実アプリでは起きない content と snapshot のズレを
			// 仕様として固定してしまう)。
			// A↔B を 2 往復するので復帰は 3 回 (B→A, A→B, B→A)。B 側も切替のたびに
			// snapshot を持つため、A の token を見るのは最後の復帰。
			// null 返却の capture が実際に走ったこと。走ったことを pin しないと、
			// 2 回目以降 capture 自体をやめる実装でも「古い snapshot が残る」形で通る。
			expect(
				handle.captureSnapshot.mock.results.slice(capturesBeforeNull).map((r) => r.value),
			).toEqual([null, null]);
			expect(handle.restoreSnapshot).toHaveBeenCalledTimes(3);
			expect(handle.restoreSnapshot.mock.lastCall?.[0]).toBe(firstToken);
		});

		it("dirty な cache から復帰したタブは dirty のままで、autosave がその内容を保存する", async () => {
			diskContents.set("/w/a.md", "orig-a");
			diskContents.set("/w/b.md", "orig-b");
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
				useWorkspaceStore.getState().setActiveTab("/w/a.md");
			});
			await flushAsync();

			// markSaved に cached.content (第 2 引数) を渡さないと復帰時点で「保存済み」と
			// 判定され、ユーザーが追加編集しない限り二度と保存されずに編集が失われる。
			// setLoadedDoc も restoreSnapshot も docChanged を発火しないため、dirty は
			// ここで導出するしかない。
			expect(tabDirty("/w/a.md")).toBe(true);
			await advance(3000);
			expect(mockedWriteFile).toHaveBeenLastCalledWith("/w/a.md", "edited-a\n");
		});
	});
});
