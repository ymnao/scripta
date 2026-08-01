import { describe, expect, it, vi } from "vitest";
import type { Shortcut } from "../../hooks/useShortcuts";
import { type AppShortcutDeps, buildAppShortcuts } from "./appShortcuts";

vi.mock("../../lib/commands", () => ({
	closeWindow: vi.fn(),
}));

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
		// match 側のガードを通す (editor がある状態) — 未 focus 版は個別テストで差し替える
		editorViewRef: { current: { hasFocus: true } as unknown as never },
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
