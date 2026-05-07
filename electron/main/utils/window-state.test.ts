// @vitest-environment node
import type { Rectangle } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	screen: {
		getAllDisplays: vi.fn(),
	},
}));

import { screen } from "electron";
import {
	__testing,
	attachWindowStateTracker,
	isBoundsVisible,
	normalizeWindowState,
	resolveInitialGeometry,
} from "./window-state";

const { DEFAULT_BOUNDS, MIN_WIDTH, MIN_HEIGHT } = __testing;

const display = (workArea: Rectangle) =>
	({
		workArea,
		// 他フィールドは isBoundsVisible では未参照だが Display 互換のため空 Rect で埋める
		bounds: workArea,
		id: 1,
		scaleFactor: 1,
		rotation: 0,
		size: { width: workArea.width, height: workArea.height },
		workAreaSize: { width: workArea.width, height: workArea.height },
	}) as unknown as Electron.Display;

beforeEach(() => {
	vi.mocked(screen.getAllDisplays).mockReset();
});

describe("isBoundsVisible", () => {
	it("returns true when bounds overlap any display workArea", () => {
		vi.mocked(screen.getAllDisplays).mockReturnValue([
			display({ x: 0, y: 0, width: 1920, height: 1080 }),
		]);
		expect(isBoundsVisible({ x: 100, y: 100, width: 800, height: 600 })).toBe(true);
	});

	it("returns true when bounds overlap one of multiple displays", () => {
		vi.mocked(screen.getAllDisplays).mockReturnValue([
			display({ x: 0, y: 0, width: 1920, height: 1080 }),
			display({ x: 1920, y: 0, width: 1920, height: 1080 }),
		]);
		// 2 つ目の display の上にある
		expect(isBoundsVisible({ x: 2000, y: 100, width: 800, height: 600 })).toBe(true);
	});

	it("returns false when bounds are entirely off-screen", () => {
		vi.mocked(screen.getAllDisplays).mockReturnValue([
			display({ x: 0, y: 0, width: 1920, height: 1080 }),
		]);
		// 画面の右遠方 — display を unplug した時に起きる典型ケース
		expect(isBoundsVisible({ x: 10000, y: 10000, width: 800, height: 600 })).toBe(false);
	});

	it("returns false when only edges touch (zero-area intersection)", () => {
		// strict > のため 1px も内部で重ならないと不可視扱い
		vi.mocked(screen.getAllDisplays).mockReturnValue([
			display({ x: 0, y: 0, width: 1000, height: 1000 }),
		]);
		expect(isBoundsVisible({ x: 1000, y: 0, width: 500, height: 500 })).toBe(false);
	});

	it("returns true even for partially off-screen windows (overlap > 0)", () => {
		// マルチモニタ跨ぎを誤って弾かないために部分重なりは可視扱い
		vi.mocked(screen.getAllDisplays).mockReturnValue([
			display({ x: 0, y: 0, width: 1920, height: 1080 }),
		]);
		expect(isBoundsVisible({ x: 1500, y: 500, width: 800, height: 600 })).toBe(true);
	});

	it("returns false when no displays are connected", () => {
		vi.mocked(screen.getAllDisplays).mockReturnValue([]);
		expect(isBoundsVisible({ x: 0, y: 0, width: 800, height: 600 })).toBe(false);
	});
});

describe("normalizeWindowState", () => {
	it("returns null for non-object input", () => {
		expect(normalizeWindowState(null)).toBeNull();
		expect(normalizeWindowState(undefined)).toBeNull();
		expect(normalizeWindowState("foo")).toBeNull();
		expect(normalizeWindowState(42)).toBeNull();
	});

	it("returns empty object for object with no recognised fields", () => {
		expect(normalizeWindowState({})).toEqual({});
		expect(normalizeWindowState({ extra: "ignored" })).toEqual({});
	});

	it("accepts a complete WindowState", () => {
		expect(
			normalizeWindowState({
				bounds: { x: 10, y: 20, width: 800, height: 600 },
				isMaximized: true,
				isFullScreen: false,
			}),
		).toEqual({
			bounds: { x: 10, y: 20, width: 800, height: 600 },
			isMaximized: true,
			isFullScreen: false,
		});
	});

	it("rejects bounds with NaN / Infinity", () => {
		// 壊れた数値を setBounds に渡すと Electron 側で throw → 不可視ウィンドウになる
		expect(
			normalizeWindowState({ bounds: { x: Number.NaN, y: 0, width: 800, height: 600 } }),
		).toEqual({});
		expect(
			normalizeWindowState({
				bounds: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 600 },
			}),
		).toEqual({});
	});

	it("rejects bounds with non-number fields", () => {
		expect(normalizeWindowState({ bounds: { x: "0", y: 0, width: 800, height: 600 } })).toEqual({});
	});

	it("ignores non-boolean isMaximized / isFullScreen", () => {
		// truthy な non-boolean が boolean フラグとして main 側 BrowserWindow API に
		// 渡って silently ignore されたり、逆に振る舞うのを避ける
		expect(normalizeWindowState({ isMaximized: 1, isFullScreen: "true" })).toEqual({});
	});

	it("filters out unknown extra properties", () => {
		expect(
			normalizeWindowState({
				bounds: { x: 0, y: 0, width: 800, height: 600 },
				rogue: { __proto__: { polluted: true } },
			}),
		).toEqual({ bounds: { x: 0, y: 0, width: 800, height: 600 } });
	});
});

describe("resolveInitialGeometry", () => {
	beforeEach(() => {
		vi.mocked(screen.getAllDisplays).mockReturnValue([
			display({ x: 0, y: 0, width: 1920, height: 1080 }),
		]);
	});

	it("falls back to defaults when state is null", () => {
		expect(resolveInitialGeometry(null)).toEqual({
			bounds: DEFAULT_BOUNDS,
			maximize: false,
			fullScreen: false,
		});
	});

	it("falls back to defaults when state has no bounds", () => {
		expect(resolveInitialGeometry({ isMaximized: true })).toEqual({
			bounds: DEFAULT_BOUNDS,
			maximize: false,
			fullScreen: false,
		});
	});

	it("uses stored bounds when valid and visible", () => {
		const bounds = { x: 100, y: 50, width: 1024, height: 768 };
		expect(resolveInitialGeometry({ bounds, isMaximized: false })).toEqual({
			bounds,
			maximize: false,
			fullScreen: false,
		});
	});

	it("falls back to default bounds but preserves maximize flag when bounds are off-screen", () => {
		// display 抜きで bounds が見えないが、maximize 意図は残してデフォルト位置で
		// 最大化起動するのが「最も近い元の状態」
		const result = resolveInitialGeometry({
			bounds: { x: 9999, y: 9999, width: 800, height: 600 },
			isMaximized: true,
		});
		expect(result.bounds).toEqual(DEFAULT_BOUNDS);
		expect(result.maximize).toBe(true);
		expect(result.fullScreen).toBe(false);
	});

	it("falls back when stored bounds are below MIN_WIDTH/MIN_HEIGHT", () => {
		// 小さすぎる bounds を復元するとユーザーが操作できない
		const result = resolveInitialGeometry({
			bounds: { x: 100, y: 100, width: MIN_WIDTH - 1, height: MIN_HEIGHT - 1 },
		});
		expect(result.bounds).toEqual(DEFAULT_BOUNDS);
	});

	it("respects fullScreen flag", () => {
		const bounds = { x: 0, y: 0, width: 1024, height: 768 };
		expect(resolveInitialGeometry({ bounds, isFullScreen: true })).toEqual({
			bounds,
			maximize: false,
			fullScreen: true,
		});
	});
});

describe("attachWindowStateTracker", () => {
	let listeners: Map<string, Array<() => void>>;
	let isDestroyed: boolean;
	let isMaximizedFlag: boolean;
	let isFullScreenFlag: boolean;
	let normalBounds: Rectangle;

	const makeWin = () => {
		listeners = new Map();
		isDestroyed = false;
		isMaximizedFlag = false;
		isFullScreenFlag = false;
		normalBounds = { x: 10, y: 20, width: 800, height: 600 };
		return {
			on: vi.fn((event: string, handler: () => void) => {
				const arr = listeners.get(event) ?? [];
				arr.push(handler);
				listeners.set(event, arr);
			}),
			isDestroyed: () => isDestroyed,
			isMaximized: () => isMaximizedFlag,
			isFullScreen: () => isFullScreenFlag,
			getNormalBounds: () => normalBounds,
		} as unknown as Electron.BrowserWindow;
	};

	const fire = (event: string) => {
		for (const h of listeners.get(event) ?? []) h();
	};

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("debounces async saves across rapid resize/move events", () => {
		const win = makeWin();
		const saveAsync = vi.fn();
		const saveSync = vi.fn();
		attachWindowStateTracker(win, { saveAsync, saveSync, debounceMs: 100 });

		fire("resize");
		fire("move");
		fire("resize");
		expect(saveAsync).not.toHaveBeenCalled();
		vi.advanceTimersByTime(99);
		expect(saveAsync).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2);
		expect(saveAsync).toHaveBeenCalledTimes(1);
		expect(saveAsync).toHaveBeenCalledWith({
			bounds: normalBounds,
			isMaximized: false,
			isFullScreen: false,
		});
	});

	it("captures isMaximized / isFullScreen at flush time, not schedule time", () => {
		// debounce 中に最大化が確定したら、その状態を保存する
		const win = makeWin();
		const saveAsync = vi.fn();
		attachWindowStateTracker(win, { saveAsync, saveSync: vi.fn(), debounceMs: 50 });
		fire("resize");
		isMaximizedFlag = true;
		vi.advanceTimersByTime(60);
		expect(saveAsync).toHaveBeenCalledWith(expect.objectContaining({ isMaximized: true }));
	});

	it("flushes synchronously on close (no debounce wait)", () => {
		const win = makeWin();
		const saveAsync = vi.fn();
		const saveSync = vi.fn();
		attachWindowStateTracker(win, { saveAsync, saveSync, debounceMs: 100 });
		fire("resize");
		fire("close");
		// async は debounce window 内で発火しない（cancel 済み）
		vi.advanceTimersByTime(200);
		expect(saveAsync).not.toHaveBeenCalled();
		expect(saveSync).toHaveBeenCalledTimes(1);
	});

	it("does not call saveAsync after window is destroyed", () => {
		// closed event の後に debounce が flush しても getNormalBounds は呼べない
		const win = makeWin();
		const saveAsync = vi.fn();
		attachWindowStateTracker(win, { saveAsync, saveSync: vi.fn(), debounceMs: 50 });
		fire("resize");
		isDestroyed = true;
		vi.advanceTimersByTime(60);
		expect(saveAsync).not.toHaveBeenCalled();
	});

	it("does not call saveSync if the window is already destroyed at close time", () => {
		const win = makeWin();
		const saveSync = vi.fn();
		attachWindowStateTracker(win, { saveAsync: vi.fn(), saveSync, debounceMs: 50 });
		isDestroyed = true;
		fire("close");
		expect(saveSync).not.toHaveBeenCalled();
	});

	it("subscribes to all expected window events", () => {
		const win = makeWin();
		attachWindowStateTracker(win, { saveAsync: vi.fn(), saveSync: vi.fn() });
		expect(win.on).toHaveBeenCalledWith("resize", expect.any(Function));
		expect(win.on).toHaveBeenCalledWith("move", expect.any(Function));
		expect(win.on).toHaveBeenCalledWith("maximize", expect.any(Function));
		expect(win.on).toHaveBeenCalledWith("unmaximize", expect.any(Function));
		expect(win.on).toHaveBeenCalledWith("enter-full-screen", expect.any(Function));
		expect(win.on).toHaveBeenCalledWith("leave-full-screen", expect.any(Function));
		expect(win.on).toHaveBeenCalledWith("close", expect.any(Function));
	});

	it("dispose cancels pending debounced save", () => {
		const win = makeWin();
		const saveAsync = vi.fn();
		const dispose = attachWindowStateTracker(win, {
			saveAsync,
			saveSync: vi.fn(),
			debounceMs: 50,
		});
		fire("resize");
		dispose();
		vi.advanceTimersByTime(60);
		expect(saveAsync).not.toHaveBeenCalled();
	});

	it("swallows saveAsync exceptions to avoid crashing the window", () => {
		const win = makeWin();
		const saveAsync = vi.fn(() => {
			throw new Error("disk full");
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		attachWindowStateTracker(win, { saveAsync, saveSync: vi.fn(), debounceMs: 10 });
		fire("resize");
		expect(() => vi.advanceTimersByTime(20)).not.toThrow();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
