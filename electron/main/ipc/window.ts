import { join } from "node:path";
import { app, BrowserWindow, session } from "electron";
import { handle } from "../utils/ipc-handle";
import { canonicalize, isPathAllowed } from "../utils/path-guard";
import { attachWindowLifecycle } from "../utils/window-lifecycle";
import { setActiveWorkspaceForWindow } from "./workspace";

// conflict-resolver ウィンドウの単一
// インスタンス管理。canonical な workspace path をキーにして同じ workspace の
// 重複生成を防ぐ。複数 workspace を別 window で開く将来の経路にも自然対応。
const conflictWindows = new Map<string, BrowserWindow>();

// 親 window が allowedRoots に持つ workspace のみ開かせる。renderer 側からの
// `workspacePath` 引数を信頼せず、main 側で再検証 → 子 window への登録までを
// 一貫して main プロセスの責務に閉じ込める。
async function createConflictWindow(parentSenderId: number, workspacePath: string): Promise<void> {
	if (!isPathAllowed(parentSenderId, workspacePath)) {
		throw new Error("Permission denied: workspace not registered for parent window");
	}
	const canonical = canonicalize(workspacePath);

	const existing = conflictWindows.get(canonical);
	if (existing && !existing.isDestroyed()) {
		if (existing.isMinimized()) existing.restore();
		existing.focus();
		return;
	}

	// `BrowserWindow.fromId` は BrowserWindow.id を引数に取るが、event.sender.id
	// は webContents.id（別の id 体系）。getAllWindows() を線形探索して
	// webContents.id で照合するのが正しい。BrowserWindow.fromWebContents を
	// 使う手もあるが、impl signature が webContents 受け取りに変わって
	// テストの mock 構造が複雑になるため、senderId ベースのままで find する。
	const parent =
		BrowserWindow.getAllWindows().find(
			(w) => !w.isDestroyed() && w.webContents.id === parentSenderId,
		) ?? undefined;

	const win = new BrowserWindow({
		width: 900,
		height: 600,
		show: false,
		title: "コンフリクト解消",
		// drag region / タブストリップを持たないため trafficLightPosition は設定せず
		// macOS デフォルトに任せる（main window 用の調整値を流用しない）。
		titleBarStyle: "hiddenInset",
		// `parent` を指定すると親 close で子も追従して close。
		parent,
		modal: false,
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	attachWindowLifecycle(win);
	win.on("ready-to-show", () => win.show());
	win.on("closed", () => {
		conflictWindows.delete(canonical);
	});

	// 親 → 子の権限委譲。ConflictWindow.tsx は `workspaceSet` を呼ばないため、
	// ここで子 webContents.id 向けに registerWorkspaceRoot を実行しないと
	// `gitCheckRepo` 等の path-guard が通らない。
	// `setActiveWorkspaceForWindow` は内部で registerWorkspaceRoot を呼ぶ。
	setActiveWorkspaceForWindow(win.webContents.id, canonical);
	conflictWindows.set(canonical, win);

	const search = `?conflict=true&workspacePath=${encodeURIComponent(workspacePath)}`;
	try {
		if (process.env.ELECTRON_RENDERER_URL) {
			await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${search}`);
		} else {
			await win.loadFile(join(__dirname, "../renderer/index.html"), { search });
		}
	} catch (e) {
		// load 失敗時に Map / allowedRoots を残すと、再 open は壊れた window を
		// focus するだけになる。明示的に cleanup してから rethrow。
		// real Electron では win.destroy() が closed event を発火し、
		// attachWindowLifecycle 経由でも cleanup が走るが、両者とも冪等なため
		// explicit に書いておく（test mock では closed event が発火しないため）。
		conflictWindows.delete(canonical);
		setActiveWorkspaceForWindow(win.webContents.id, null);
		if (!win.isDestroyed()) win.destroy();
		throw e;
	}
}

export function registerWindowIpc(): void {
	handle("app:get-version", async () => app.getVersion());

	handle("window:close", async (event) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		win?.close();
	});

	handle("window:open-conflict", (event, workspacePath: string) =>
		createConflictWindow(event.sender.id, workspacePath),
	);

	handle("window:clear-webview-data", async () => {
		await session.defaultSession.clearStorageData();
	});
}

export const __testing = {
	createConflictWindow,
	conflictWindows,
};
