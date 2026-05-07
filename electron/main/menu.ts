import { is } from "@electron-toolkit/utils";
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";

// 旧 Tauri 版 (`src-tauri/src/lib.rs::setup_menu`) と等価のメニュー項目を Electron で
// 再構築する。renderer 側 AppLayout は既に preload 経由で
// `onMenuEvent("open-settings" | "open-help" | "export")` を購読しているため、
// menu の click ハンドラはフォーカス中の webContents へ `menu:<name>` を送るだけ。
//
// 新規ウィンドウ生成はフロントから呼べないので、main 側のロジック（createWindow を
// `?newWindow=true` で起動）を `MenuHandlers.newWindow` 経由で注入する。

export type MenuEventName = "open-settings" | "open-help" | "export";

export interface MenuHandlers {
	newWindow: () => void;
}

// 旧 Tauri は `is_focused()` の中から該当 window だけに emit していた。Electron の
// `BrowserWindow.getFocusedWindow()` は menu click 時に発火元 window を返すため
// 同じ意図を達成できる。focus 中の window が無い瞬間（未起動 / アクティベート前）は
// 全 window のうち最初の生存 window にフォールバックする — broadcasting すると
// conflict-resolver サブウィンドウが open-help などを誤って受け取ってしまう。
function sendMenuEvent(name: MenuEventName): void {
	const focused = BrowserWindow.getFocusedWindow();
	const target =
		focused && !focused.isDestroyed()
			? focused
			: BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
	if (!target) return;
	target.webContents.send(`menu:${name}`);
}

export function buildMenuTemplate(handlers: MenuHandlers): MenuItemConstructorOptions[] {
	const isMac = process.platform === "darwin";

	const appSubmenu: MenuItemConstructorOptions[] = [
		{ role: "about" },
		{ type: "separator" },
		// Settings... は accelerator Cmd+, を旧 Tauri から踏襲。renderer の Cmd+,
		// ハンドラは存在しないため accelerator が menu 側だけで消費されても影響なし。
		{
			label: "Settings...",
			accelerator: "CmdOrCtrl+,",
			click: () => sendMenuEvent("open-settings"),
		},
		{ type: "separator" },
		{ role: "services" },
		{ type: "separator" },
		{ role: "hide" },
		{ role: "hideOthers" },
		{ role: "unhide" },
		{ type: "separator" },
		{ role: "quit" },
	];

	const fileSubmenu: MenuItemConstructorOptions[] = [
		{ label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: handlers.newWindow },
		{ type: "separator" },
		// Cmd+Shift+E は AppLayout でも keydown で消費しているが、menu に accelerator を
		// 登録すると Electron 側が先に拾い、renderer に keydown が伝播しないため
		// 二重実行にはならない。menu 側の click → emit → onMenuEvent で AppLayout の
		// handleExport を起動するルートで一本化される。
		{
			label: "エクスポート...",
			accelerator: "CmdOrCtrl+Shift+E",
			click: () => sendMenuEvent("export"),
		},
		{ type: "separator" },
		// 非 macOS では File メニューに Quit を入れるのが慣習。macOS 側は appMenu で持つ。
		isMac ? { role: "close" } : { role: "quit" },
	];

	const editSubmenu: MenuItemConstructorOptions[] = [
		{ role: "undo" },
		{ role: "redo" },
		{ type: "separator" },
		{ role: "cut" },
		{ role: "copy" },
		{ role: "paste" },
		{ role: "selectAll" },
	];

	// 旧 Tauri は View メニューを持たないが、Electron で View を完全に外すと
	// Cmd+Shift+I (DevTools) / F11 (fullscreen) などの組み込みショートカットが効かなくなる。
	// dev では DevTools / reload を出し、prod では zoom / fullscreen のみ提示する。
	const viewSubmenu: MenuItemConstructorOptions[] = is.dev
		? [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			]
		: [
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			];

	const windowSubmenu: MenuItemConstructorOptions[] = isMac
		? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
		: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }];

	const helpSubmenu: MenuItemConstructorOptions[] = [
		{
			label: "Keyboard Shortcuts",
			accelerator: "F1",
			click: () => sendMenuEvent("open-help"),
		},
	];

	const template: MenuItemConstructorOptions[] = [];
	if (isMac) template.push({ label: app.name, submenu: appSubmenu });
	template.push({ label: "File", submenu: fileSubmenu });
	template.push({ label: "Edit", submenu: editSubmenu });
	template.push({ label: "View", submenu: viewSubmenu });
	template.push({ label: "Window", submenu: windowSubmenu });
	template.push({ role: "help", submenu: helpSubmenu });
	return template;
}

export function setApplicationMenu(handlers: MenuHandlers): void {
	const menu = Menu.buildFromTemplate(buildMenuTemplate(handlers));
	Menu.setApplicationMenu(menu);
}

export const __testing = {
	sendMenuEvent,
};
