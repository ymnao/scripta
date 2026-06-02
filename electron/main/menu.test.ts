// @vitest-environment node
import type { MenuItemConstructorOptions } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factory は hoist されるため top-level 変数を直接参照できない。
// vi.hoisted で初期化を巻き上げて factory から参照する。
const { mockIs, mockedSend, mockedWin } = vi.hoisted(() => {
	const send = vi.fn();
	const win = {
		isDestroyed: () => false,
		webContents: { send },
	};
	return { mockIs: { dev: false }, mockedSend: send, mockedWin: win };
});

vi.mock("@electron-toolkit/utils", () => ({
	is: mockIs,
}));

vi.mock("electron", () => ({
	app: { name: "scripta" },
	BrowserWindow: {
		getFocusedWindow: vi.fn(() => mockedWin),
		getAllWindows: vi.fn(() => [mockedWin]),
	},
	Menu: {
		buildFromTemplate: vi.fn((template) => template),
		setApplicationMenu: vi.fn(),
	},
}));

import { app, BrowserWindow, Menu } from "electron";
import { __testing, buildMenuTemplate, setApplicationMenu } from "./menu";

const findItem = (
	template: MenuItemConstructorOptions[],
	submenuLabel: string,
	itemLabelOrRole: string,
): MenuItemConstructorOptions | undefined => {
	const sub = template.find((t) => t.label === submenuLabel || t.role === submenuLabel);
	const list = sub?.submenu as MenuItemConstructorOptions[] | undefined;
	return list?.find((i) => i.label === itemLabelOrRole || i.role === itemLabelOrRole);
};

const withPlatform = (platform: NodeJS.Platform, fn: () => void): void => {
	const orig = process.platform;
	Object.defineProperty(process, "platform", { value: platform });
	try {
		fn();
	} finally {
		Object.defineProperty(process, "platform", { value: orig });
	}
};

beforeEach(() => {
	mockIs.dev = false;
	mockedSend.mockReset();
	vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(mockedWin as never);
	vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockedWin] as never);
	vi.mocked(Menu.buildFromTemplate).mockClear();
	vi.mocked(Menu.setApplicationMenu).mockClear();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("buildMenuTemplate", () => {
	it("includes app menu only on macOS", () => {
		withPlatform("darwin", () => {
			const tpl = buildMenuTemplate({ newWindow: vi.fn() });
			expect(tpl[0].label).toBe(app.name);
			expect(tpl.find((t) => t.label === "File")).toBeDefined();
		});
	});

	it("omits app menu on Linux/Windows", () => {
		withPlatform("linux", () => {
			const tpl = buildMenuTemplate({ newWindow: vi.fn() });
			expect(tpl[0].label).toBe("File");
		});
	});

	it("File > New Window invokes the injected handler with the configured accelerator", () => {
		const newWindow = vi.fn();
		const tpl = buildMenuTemplate({ newWindow });
		const item = findItem(tpl, "File", "New Window");
		expect(item).toBeDefined();
		expect(item?.accelerator).toBe("CmdOrCtrl+Shift+N");
		(item?.click as () => void)();
		expect(newWindow).toHaveBeenCalledTimes(1);
	});

	it("File > エクスポート... emits menu:export to the focused window", () => {
		const tpl = buildMenuTemplate({ newWindow: vi.fn() });
		const item = findItem(tpl, "File", "エクスポート...");
		expect(item).toBeDefined();
		expect(item?.accelerator).toBe("CmdOrCtrl+Shift+E");
		(item?.click as () => void)();
		expect(mockedSend).toHaveBeenCalledWith("menu:export");
	});

	it("Help > Keyboard Shortcuts emits menu:open-help with F1", () => {
		const tpl = buildMenuTemplate({ newWindow: vi.fn() });
		const helpEntry = tpl.find((t) => t.role === "help");
		const items = helpEntry?.submenu as MenuItemConstructorOptions[] | undefined;
		const help = items?.find((i) => i.label === "Keyboard Shortcuts");
		expect(help).toBeDefined();
		expect(help?.accelerator).toBe("F1");
		(help?.click as () => void)();
		expect(mockedSend).toHaveBeenCalledWith("menu:open-help");
	});

	it("App > Settings... emits menu:open-settings on macOS", () => {
		withPlatform("darwin", () => {
			const tpl = buildMenuTemplate({ newWindow: vi.fn() });
			const item = findItem(tpl, app.name, "Settings...");
			expect(item).toBeDefined();
			expect(item?.accelerator).toBe("CmdOrCtrl+,");
			(item?.click as () => void)();
			expect(mockedSend).toHaveBeenCalledWith("menu:open-settings");
		});
	});

	it("View menu hides reload/devTools items in production", () => {
		mockIs.dev = false;
		const tpl = buildMenuTemplate({ newWindow: vi.fn() });
		const view = tpl.find((t) => t.label === "View");
		const items = view?.submenu as MenuItemConstructorOptions[] | undefined;
		const roles = items?.map((i) => i.role).filter(Boolean) ?? [];
		expect(roles).not.toContain("reload");
		expect(roles).not.toContain("toggleDevTools");
		expect(roles).toContain("togglefullscreen");
	});

	it("View menu exposes reload/devTools in development", () => {
		mockIs.dev = true;
		const tpl = buildMenuTemplate({ newWindow: vi.fn() });
		const view = tpl.find((t) => t.label === "View");
		const items = view?.submenu as MenuItemConstructorOptions[] | undefined;
		const roles = items?.map((i) => i.role).filter(Boolean) ?? [];
		expect(roles).toContain("reload");
		expect(roles).toContain("toggleDevTools");
	});

	it("Edit menu は標準 role のみ（accelerator は OS にまかせ、focus に応じた native 経路へ通す）", () => {
		// Undo / Redo を custom click + accelerator で固定経路にすると、Settings /
		// Search / Command Palette / Mermaid textarea などフォーカス先の input で
		// native undo が壊れる。標準 role に任せれば `undo:` セレクタが現在の
		// 編集対象（contentEditable / textarea）へ送られ、editor 内では beforeinput
		// historyUndo → CM history（表セルも EditableTableWidget.ignoreEvent を経て
		// 同経路に流れる）が、それ以外の input では native undo が走る。
		const tpl = buildMenuTemplate({ newWindow: vi.fn() });
		const edit = tpl.find((t) => t.label === "Edit");
		const items = (edit?.submenu as MenuItemConstructorOptions[] | undefined) ?? [];
		const roles = new Set(items.map((i) => i.role).filter(Boolean));
		// 標準の編集ロールが揃っていることを確認する
		expect(roles.has("undo")).toBe(true);
		expect(roles.has("redo")).toBe(true);
		expect(roles.has("cut")).toBe(true);
		expect(roles.has("copy")).toBe(true);
		expect(roles.has("paste")).toBe(true);
		expect(roles.has("selectAll")).toBe(true);

		// Undo / Redo は accelerator や registerAccelerator: false 等の上書きを持たない
		// （= OS 標準の挙動に完全に委ねる）。
		const undoItem = items.find((i) => i.role === "undo");
		const redoItem = items.find((i) => i.role === "redo");
		expect(undoItem?.accelerator).toBeUndefined();
		expect(redoItem?.accelerator).toBeUndefined();
		expect(undoItem?.registerAccelerator).toBeUndefined();
		expect(redoItem?.registerAccelerator).toBeUndefined();
		expect(undoItem?.click).toBeUndefined();
		expect(redoItem?.click).toBeUndefined();
	});
});

describe("sendMenuEvent", () => {
	it("targets the focused window when one exists", () => {
		__testing.sendMenuEvent("open-settings");
		expect(mockedSend).toHaveBeenCalledWith("menu:open-settings");
	});

	it("falls back to the first non-destroyed window when nothing is focused", () => {
		vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null as never);
		__testing.sendMenuEvent("export");
		expect(mockedSend).toHaveBeenCalledWith("menu:export");
	});

	it("does nothing when no windows exist", () => {
		vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null as never);
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
		expect(() => __testing.sendMenuEvent("open-help")).not.toThrow();
		expect(mockedSend).not.toHaveBeenCalled();
	});

	it("skips destroyed focused window and finds an alternative", () => {
		const dead = {
			isDestroyed: () => true,
			webContents: { send: vi.fn() },
		};
		const live = {
			isDestroyed: () => false,
			webContents: { send: vi.fn() },
		};
		vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(dead as never);
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([dead, live] as never);
		__testing.sendMenuEvent("open-help");
		expect(dead.webContents.send).not.toHaveBeenCalled();
		expect(live.webContents.send).toHaveBeenCalledWith("menu:open-help");
	});
});

describe("setApplicationMenu", () => {
	it("builds template + assigns to Menu", () => {
		setApplicationMenu({ newWindow: vi.fn() });
		expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
		expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
	});
});
