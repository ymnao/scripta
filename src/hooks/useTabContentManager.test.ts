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
			// 兄弟は startsWith(prefix) にマッチしないので不変。prefix に区切りを付けずに
			// 判定すると /w/a/foobar/y.md まで /w/a/bazbar/y.md へ移動してしまう。
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
});
