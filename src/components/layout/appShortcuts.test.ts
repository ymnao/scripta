import type { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Shortcut } from "../../hooks/useShortcuts";
import { useWorkspaceStore } from "../../stores/workspace";
import { type AppShortcutDeps, buildAppShortcuts } from "./appShortcuts";

vi.mock("../../lib/commands", () => ({
	closeWindow: vi.fn(),
}));

/** match 側のガードを通し、editor-search-bar の run が読む最小限だけを持つ view。 */
function makeView(selectedText = ""): EditorView {
	return {
		hasFocus: true,
		state: {
			selection: { main: { empty: selectedText === "", from: 0, to: selectedText.length } },
			sliceDoc: () => selectedText,
		},
	} as unknown as EditorView;
}

function makeDeps(overrides: Partial<AppShortcutDeps> = {}): AppShortcutDeps {
	return {
		activatePrevTab: vi.fn(),
		activateNextTab: vi.fn(),
		handleGoBack: vi.fn(async () => {}),
		handleGoForward: vi.fn(async () => {}),
		activeTabId: 1,
		handleCloseTab: vi.fn(async () => {}),
		setSidebarVisible: vi.fn(),
		setSidebarPanel: vi.fn(),
		setSlideViewActive: vi.fn(),
		handleExport: vi.fn(),
		searchInputRef: { current: null },
		// editor がある状態。未 focus / 未 mount 版は個別テストで差し替える
		editorViewRef: { current: makeView() },
		searchBarOpenRef: { current: false },
		searchBarHandleRef: { current: null },
		setSearchBarExpanded: vi.fn(),
		setSearchBarInitialText: vi.fn(),
		setSearchBarOpen: vi.fn(),
		workspacePath: "/ws",
		openNewTab: vi.fn(),
		toggleScratchpad: vi.fn(),
		setGoToLineOpen: vi.fn(),
		setCommandPaletteOpen: vi.fn(),
		setSettingsOpen: vi.fn(),
		setHelpOpen: vi.fn(),
		slideShowOpen: false,
		commandPaletteOpen: false,
		settingsOpen: false,
		helpOpen: false,
		exportOpen: false,
		startSlideShow: vi.fn(),
		...overrides,
	};
}

interface EventShape {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	isComposing: boolean;
}

function makeEvent(key: string, mods: Partial<Omit<EventShape, "key">> = {}): KeyboardEvent {
	return {
		key,
		metaKey: false,
		ctrlKey: false,
		shiftKey: false,
		altKey: false,
		isComposing: false,
		...mods,
	} as KeyboardEvent;
}

function matchingIds(shortcuts: Shortcut[], event: KeyboardEvent): string[] {
	return shortcuts.filter((s) => s.match(event)).map((s) => s.id);
}

/** shortcuts が扱う全 key と、その shift 押下時に届く可能性のある表記。 */
const KEYS = [
	"{",
	"[",
	"}",
	"]",
	"ArrowLeft",
	"ArrowRight",
	"w",
	"W",
	"/",
	"e",
	"E",
	"s",
	"S",
	"f",
	"F",
	"u",
	"U",
	"b",
	"B",
	"h",
	"H",
	"t",
	"T",
	"j",
	"J",
	"g",
	"G",
	"p",
	"P",
	",",
	"F1",
	"F5",
];

describe("buildAppShortcuts", () => {
	it("同一イベントに複数のエントリがマッチしない (配列順に依存しない)", () => {
		const shortcuts = buildAppShortcuts(makeDeps());
		const ambiguous: string[] = [];

		for (const key of KEYS) {
			for (const meta of [false, true]) {
				for (const ctrl of [false, true]) {
					for (const shift of [false, true]) {
						for (const alt of [false, true]) {
							const event = makeEvent(key, {
								metaKey: meta,
								ctrlKey: ctrl,
								shiftKey: shift,
								altKey: alt,
							});
							const ids = matchingIds(shortcuts, event);
							if (ids.length > 1) {
								ambiguous.push(
									`key=${key} meta=${meta} ctrl=${ctrl} shift=${shift} alt=${alt} → ${ids.join(", ")}`,
								);
							}
						}
					}
				}
			}
		}

		// 曖昧さが 0 なので「shift 有り側を先に置く」順序規約は現状 defense-in-depth。
		// エントリ追加でこの前提が崩れたら (= 順序が挙動を決めるようになったら) ここで気付ける。
		expect(ambiguous).toEqual([]);
	});

	it.each([
		["prev-tab", "[", { metaKey: true, shiftKey: true }],
		["prev-tab", "{", { metaKey: true, shiftKey: true }],
		["next-tab", "]", { metaKey: true, shiftKey: true }],
		["next-tab", "}", { metaKey: true, shiftKey: true }],
		["history-back-bracket", "[", { metaKey: true }],
		["history-forward-bracket", "]", { metaKey: true }],
		["history-back-alt", "ArrowLeft", { altKey: true }],
		["history-forward-alt", "ArrowRight", { altKey: true }],
		["close-tab-or-window", "w", { metaKey: true }],
		["close-tab-or-window", "W", { metaKey: true, shiftKey: true }],
		["toggle-sidebar", "/", { metaKey: true }],
		["sidebar-files", "e", { metaKey: true }],
		["export", "E", { metaKey: true, shiftKey: true }],
		["toggle-slide-view", "S", { metaKey: true, shiftKey: true }],
		["sidebar-search", "F", { metaKey: true, shiftKey: true }],
		["sidebar-unresolved", "U", { metaKey: true, shiftKey: true }],
		["sidebar-backlink", "B", { metaKey: true, shiftKey: true }],
		["editor-search-bar", "f", { metaKey: true }],
		["editor-search-bar", "h", { metaKey: true }],
		["new-tab", "t", { metaKey: true }],
		["toggle-scratchpad", "j", { metaKey: true }],
		["go-to-line", "g", { metaKey: true }],
		["command-palette", "p", { metaKey: true }],
		["settings", ",", { metaKey: true }],
		["help", "F1", {}],
		["slide-show", "F5", {}],
	] as const)("%s は %s (%o) にマッチする", (id, key, mods) => {
		const shortcuts = buildAppShortcuts(makeDeps());
		expect(matchingIds(shortcuts, makeEvent(key, mods))).toEqual([id]);
	});

	it.each([
		["commandPaletteOpen"],
		["exportOpen"],
		["settingsOpen"],
		["helpOpen"],
	] as const)("slide-show は %s の間は F5 を横取りしない", (flag) => {
		const shortcuts = buildAppShortcuts(makeDeps({ [flag]: true }));
		expect(matchingIds(shortcuts, makeEvent("F5"))).toEqual([]);
	});

	it("slide-show は既に開いている間 / IME 合成中は F5 を横取りしない", () => {
		expect(
			matchingIds(buildAppShortcuts(makeDeps({ slideShowOpen: true })), makeEvent("F5")),
		).toEqual([]);
		expect(
			matchingIds(buildAppShortcuts(makeDeps()), makeEvent("F5", { isComposing: true })),
		).toEqual([]);
	});

	it("Ctrl でも Cmd と同じエントリにマッチする", () => {
		const shortcuts = buildAppShortcuts(makeDeps());
		expect(matchingIds(shortcuts, makeEvent("p", { ctrlKey: true }))).toEqual(["command-palette"]);
	});

	it("editor が無いとき Cmd+F / Cmd+G はマッチしない (preventDefault を走らせない)", () => {
		const shortcuts = buildAppShortcuts(makeDeps({ editorViewRef: { current: null } }));
		expect(matchingIds(shortcuts, makeEvent("f", { metaKey: true }))).toEqual([]);
		expect(matchingIds(shortcuts, makeEvent("g", { metaKey: true }))).toEqual([]);
	});
});

/**
 * run の配線 (どのエントリがどの deps を呼ぶか) を全 22 エントリ分 pin する。
 *
 * AppLayout.test.tsx はキー dispatch 経由で 9 エントリしか踏んでおらず、残りは
 * run を no-op に差し替えても green のままだった。ファクトリ化で mock deps を
 * 与えられるようになったので、ここで全エントリを直接叩いて塞ぐ。
 */
describe("buildAppShortcuts の run 配線", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useWorkspaceStore.setState({ activeTabPath: "/ws/note.md" });
	});

	function run(deps: AppShortcutDeps, id: string, key = "x", mods = {}): void {
		const entry = buildAppShortcuts(deps).find((s) => s.id === id);
		if (!entry) throw new Error(`shortcut not found: ${id}`);
		entry.run(makeEvent(key, mods));
	}

	/** 関数形式の setState 更新を、初期値を与えて実際に適用した結果で検証する。 */
	function applyUpdater<T>(fn: unknown, prev: T): T {
		expect(typeof fn).toBe("function");
		return (fn as (p: T) => T)(prev);
	}

	/**
	 * boolean トグルの updater を **両方向**適用して検証する。
	 * 片方向だけだと `() => true` のような定数返却関数でも通ってしまい、
	 * 「もう一度押しても閉じない」退行を取り逃がす (round 2 レビュー指摘)。
	 */
	function expectToggle(fn: unknown): void {
		expect(applyUpdater(fn, false)).toBe(true);
		expect(applyUpdater(fn, true)).toBe(false);
	}

	it("prev-tab / next-tab はタブ移動を呼ぶ", () => {
		const deps = makeDeps();
		run(deps, "prev-tab");
		expect(deps.activatePrevTab).toHaveBeenCalledTimes(1);
		run(deps, "next-tab");
		expect(deps.activateNextTab).toHaveBeenCalledTimes(1);
	});

	it.each([
		["history-back-bracket", "handleGoBack"],
		["history-back-alt", "handleGoBack"],
		["history-forward-bracket", "handleGoForward"],
		["history-forward-alt", "handleGoForward"],
	] as const)("%s は %s を呼ぶ", (id, handler) => {
		const deps = makeDeps();
		run(deps, id);
		expect(deps[handler]).toHaveBeenCalledTimes(1);
		const other = handler === "handleGoBack" ? deps.handleGoForward : deps.handleGoBack;
		expect(other).not.toHaveBeenCalled();
	});

	it("close-tab-or-window は shift 無しで active タブを閉じる", () => {
		const deps = makeDeps({ activeTabId: 7 });
		run(deps, "close-tab-or-window", "w", { metaKey: true });
		expect(deps.handleCloseTab).toHaveBeenCalledWith(7);
	});

	it("close-tab-or-window はタブが無ければウィンドウを閉じる", async () => {
		const { closeWindow } = await import("../../lib/commands");
		const deps = makeDeps({ activeTabId: null });
		run(deps, "close-tab-or-window", "w", { metaKey: true });
		expect(deps.handleCloseTab).not.toHaveBeenCalled();
		expect(closeWindow).toHaveBeenCalledTimes(1);
	});

	it("close-tab-or-window は shift 有りならタブがあってもウィンドウを閉じる", async () => {
		const { closeWindow } = await import("../../lib/commands");
		const deps = makeDeps({ activeTabId: 7 });
		run(deps, "close-tab-or-window", "W", { metaKey: true, shiftKey: true });
		expect(deps.handleCloseTab).not.toHaveBeenCalled();
		expect(closeWindow).toHaveBeenCalledTimes(1);
	});

	it("toggle-sidebar はサイドバー表示を反転する", () => {
		const deps = makeDeps();
		run(deps, "toggle-sidebar");
		expectToggle(vi.mocked(deps.setSidebarVisible).mock.calls[0][0]);
	});

	it.each([
		["sidebar-files", "files"],
		["sidebar-search", "search"],
	] as const)("%s は %s パネルへ切り替える", (id, panel) => {
		const deps = makeDeps();
		run(deps, id);
		expect(deps.setSidebarPanel).toHaveBeenCalledWith(panel);
	});

	it("sidebar-search は次フレームで検索入力へ focus する", () => {
		const raf = vi
			.spyOn(globalThis, "requestAnimationFrame")
			.mockImplementation((cb: FrameRequestCallback) => {
				cb(0);
				return 0;
			});
		try {
			const focus = vi.fn();
			const deps = makeDeps({
				searchInputRef: { current: { focus } as unknown as HTMLInputElement },
			});
			run(deps, "sidebar-search");
			expect(focus).toHaveBeenCalledTimes(1);

			// ref 未設定でも throw しない (パネル未 mount のタイミング)
			const noInput = makeDeps();
			expect(() => run(noInput, "sidebar-search")).not.toThrow();
		} finally {
			raf.mockRestore();
		}
	});

	it.each([
		["sidebar-unresolved", "unresolved"],
		["sidebar-backlink", "backlink"],
	] as const)("%s は同じパネルなら files へ戻す", (id, panel) => {
		const deps = makeDeps();
		run(deps, id);
		const updater = vi.mocked(deps.setSidebarPanel).mock.calls[0][0];
		expect(applyUpdater(updater, "files" as const)).toBe(panel);
		expect(applyUpdater(updater, panel)).toBe("files");
	});

	it("toggle-slide-view は通常タブでのみスライド表示を反転する", () => {
		const deps = makeDeps();
		run(deps, "toggle-slide-view");
		expectToggle(vi.mocked(deps.setSlideViewActive).mock.calls[0][0]);

		useWorkspaceStore.setState({ activeTabPath: "newtab://1" });
		const onNewTab = makeDeps();
		run(onNewTab, "toggle-slide-view");
		expect(onNewTab.setSlideViewActive).not.toHaveBeenCalled();

		useWorkspaceStore.setState({ activeTabPath: null });
		const noTab = makeDeps();
		run(noTab, "toggle-slide-view");
		expect(noTab.setSlideViewActive).not.toHaveBeenCalled();
	});

	it("export は active タブのパスを渡す (newtab では呼ばない)", () => {
		const deps = makeDeps();
		run(deps, "export");
		expect(deps.handleExport).toHaveBeenCalledWith("/ws/note.md");

		useWorkspaceStore.setState({ activeTabPath: "newtab://1" });
		const onNewTab = makeDeps();
		run(onNewTab, "export");
		expect(onNewTab.handleExport).not.toHaveBeenCalled();

		useWorkspaceStore.setState({ activeTabPath: null });
		const noTab = makeDeps();
		run(noTab, "export");
		expect(noTab.handleExport).not.toHaveBeenCalled();
	});

	it("editor-search-bar は閉じていれば選択文字列を初期値にして開く", () => {
		const deps = makeDeps({ editorViewRef: { current: makeView("needle") } });
		run(deps, "editor-search-bar", "f", { metaKey: true });
		expect(deps.setSearchBarInitialText).toHaveBeenCalledWith("needle");
		expect(deps.setSearchBarExpanded).toHaveBeenCalledWith(false);
		expect(deps.setSearchBarOpen).toHaveBeenCalledWith(true);
	});

	it("editor-search-bar は Cmd+H なら置換欄を開いた状態にする", () => {
		const deps = makeDeps();
		run(deps, "editor-search-bar", "h", { metaKey: true });
		expect(deps.setSearchBarExpanded).toHaveBeenCalledWith(true);
	});

	it("editor-search-bar は開いている間は既存バーへ委譲する", () => {
		const handle = { setSearch: vi.fn(), focusInput: vi.fn() };
		const deps = makeDeps({
			searchBarOpenRef: { current: true },
			searchBarHandleRef: { current: handle },
			editorViewRef: { current: makeView("needle") },
		});
		run(deps, "editor-search-bar", "f", { metaKey: true });
		expect(handle.setSearch).toHaveBeenCalledWith("needle");
		expect(deps.setSearchBarOpen).not.toHaveBeenCalled();

		const noSelection = makeDeps({
			searchBarOpenRef: { current: true },
			searchBarHandleRef: { current: handle },
		});
		run(noSelection, "editor-search-bar", "f", { metaKey: true });
		expect(handle.focusInput).toHaveBeenCalledTimes(1);
	});

	it("editor-search-bar は開いている状態の Cmd+H で置換欄を展開する", () => {
		const deps = makeDeps({
			searchBarOpenRef: { current: true },
			searchBarHandleRef: { current: { setSearch: vi.fn(), focusInput: vi.fn() } },
		});
		run(deps, "editor-search-bar", "h", { metaKey: true });
		expect(deps.setSearchBarExpanded).toHaveBeenCalledWith(true);

		// Cmd+F では展開しない (h 分岐であることを固定する)
		const withF = makeDeps({
			searchBarOpenRef: { current: true },
			searchBarHandleRef: { current: { setSearch: vi.fn(), focusInput: vi.fn() } },
		});
		run(withF, "editor-search-bar", "f", { metaKey: true });
		expect(withF.setSearchBarExpanded).not.toHaveBeenCalled();
	});

	it("editor-search-bar は 200 文字を超える選択を検索初期値にしない", () => {
		const under = makeDeps({ editorViewRef: { current: makeView("x".repeat(200)) } });
		run(under, "editor-search-bar", "f", { metaKey: true });
		expect(under.setSearchBarInitialText).toHaveBeenCalledWith("x".repeat(200));

		const over = makeDeps({ editorViewRef: { current: makeView("x".repeat(201)) } });
		run(over, "editor-search-bar", "f", { metaKey: true });
		expect(over.setSearchBarInitialText).toHaveBeenCalledWith("");
	});

	it.each([
		["new-tab", "openNewTab"],
		["toggle-scratchpad", "toggleScratchpad"],
	] as const)("%s は workspace がある時だけ %s を呼ぶ", (id, handler) => {
		const withWorkspace = makeDeps();
		run(withWorkspace, id);
		expect(withWorkspace[handler]).toHaveBeenCalledTimes(1);

		const without = makeDeps({ workspacePath: null });
		run(without, id);
		expect(without[handler]).not.toHaveBeenCalled();
	});

	it.each([
		["go-to-line", "setGoToLineOpen"],
		["command-palette", "setCommandPaletteOpen"],
		["settings", "setSettingsOpen"],
		["help", "setHelpOpen"],
	] as const)("%s は %s を反転する", (id, setter) => {
		const deps = makeDeps();
		run(deps, id);
		expectToggle(vi.mocked(deps[setter]).mock.calls[0][0]);
	});

	it("slide-show は発表モードを起動する", () => {
		const deps = makeDeps();
		run(deps, "slide-show", "F5");
		expect(deps.startSlideShow).toHaveBeenCalledTimes(1);
	});
});
