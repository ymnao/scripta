import { join } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, session, shell } from "electron";
import { registerIpcHandlers } from "./ipc";
import { getWindowState, getWorkspacePathFromSettings, persistWindowState } from "./ipc/settings";
import { approveWorkspacePath, markWorkspacePersistenceVolatile } from "./ipc/workspace";
import { setApplicationMenu } from "./menu";
import { isSafeExternalUrl } from "./utils/url";
import { attachWindowLifecycle } from "./utils/window-lifecycle";
import { attachWindowStateTracker, resolveInitialGeometry } from "./utils/window-state";

const CSP_PROD = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' https: data: blob:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'self'",
].join("; ");

const CSP_DEV = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' https: data: blob:",
	"font-src 'self' data:",
	"connect-src 'self' ws://localhost:* http://localhost:*",
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'self'",
].join("; ");

const RENDERER_FILE_DIR = join(__dirname, "../renderer");
const openWindows = new Set<BrowserWindow>();

function isAllowedRendererUrl(url: string): boolean {
	const devUrl = process.env.ELECTRON_RENDERER_URL;
	if (devUrl) {
		try {
			const parsed = new URL(url);
			const allowed = new URL(devUrl);
			if (parsed.origin !== allowed.origin) return false;
			const basePath = allowed.pathname.endsWith("/")
				? allowed.pathname.slice(0, -1)
				: allowed.pathname;
			return parsed.pathname === basePath || parsed.pathname.startsWith(`${basePath}/`);
		} catch {
			return false;
		}
	}
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "file:") return false;
		const path = decodeURIComponent(parsed.pathname);
		return path === RENDERER_FILE_DIR || path.startsWith(`${RENDERER_FILE_DIR}/`);
	} catch {
		return false;
	}
}

interface CreateWindowOptions {
	// メニューの "New Window" から呼ばれる場合は state 復元せずデフォルト bounds で開き、
	// renderer 側 AppLayout に `?newWindow=true` を伝えて workspace 復元を抑止する。
	// （旧 Tauri 版が同じ挙動。`AppLayout.tsx` の `isNewWindow` 分岐を参照）
	newWindow?: boolean;
}

function createWindow(opts: CreateWindowOptions = {}): void {
	const isNew = opts.newWindow === true;
	const initial = isNew ? resolveInitialGeometry(null) : resolveInitialGeometry(getWindowState());
	const mainWindow = new BrowserWindow({
		x: initial.bounds.x,
		y: initial.bounds.y,
		width: initial.bounds.width,
		height: initial.bounds.height,
		show: false,
		titleBarStyle: "hiddenInset",
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	openWindows.add(mainWindow);
	attachWindowLifecycle(mainWindow, () => {
		openWindows.delete(mainWindow);
	});
	if (isNew) {
		// 補助ウィンドウからの workspace:set では settings.json の workspacePath を
		// 上書きさせない（startup の workspace 復元抑止と整合させる）。
		markWorkspacePersistenceVolatile(mainWindow.webContents.id);
	}
	// New Window は state 永続化対象から外す（メイン window の bounds が上書きされる
	// と「サブで一瞬開いただけ」のサイズで次回起動時にメイン window が起動する）
	if (!isNew) {
		// 書き込みは sync 一本（race を避けるため）。debounce 500ms により
		// 頻度は drag/resize 連打中でも収束する。
		attachWindowStateTracker(mainWindow, { save: persistWindowState });

		// 起動直後のフラッシュを避けるため maximize / fullScreen は loadFile/URL の
		// 後で適用する。BrowserWindow の constructor が x/y/width/height を受け取った
		// 後に maximize() を呼ぶと、unmaximize 時に正しい normalBounds が残る。
		if (initial.maximize) mainWindow.maximize();
		if (initial.fullScreen) mainWindow.setFullScreen(true);
	}

	mainWindow.on("ready-to-show", () => {
		mainWindow.show();
	});

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (isSafeExternalUrl(url)) {
			void shell.openExternal(url).catch((error) => {
				console.error("Failed to open external URL:", url, error);
			});
		}
		return { action: "deny" };
	});

	mainWindow.webContents.on("will-navigate", (event, url) => {
		if (isAllowedRendererUrl(url)) return;
		event.preventDefault();
		if (isSafeExternalUrl(url)) {
			void shell.openExternal(url).catch((error) => {
				console.error("Failed to open external URL:", url, error);
			});
		}
	});

	const search = isNew ? "?newWindow=true" : undefined;
	if (process.env.ELECTRON_RENDERER_URL) {
		const url = search
			? `${process.env.ELECTRON_RENDERER_URL}${search}`
			: process.env.ELECTRON_RENDERER_URL;
		void mainWindow.loadURL(url).catch((error) => {
			console.error("Failed to load renderer URL:", error);
		});
	} else {
		const loadOpts = search ? { search } : undefined;
		void mainWindow.loadFile(join(__dirname, "../renderer/index.html"), loadOpts).catch((error) => {
			console.error("Failed to load renderer file:", error);
		});
	}
}

if (is.dev) {
	app.on("browser-window-created", (_, window) => {
		optimizer.watchWindowShortcuts(window);
	});
}

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

function approveSavedWorkspaceFromSettings(): void {
	// 起動時に「前回までの workspacePath」を approve リストへ入れる。
	// register はしない（実際の register は renderer 側 AppLayout が
	// workspaceSet を呼んだ時点で行う window 単位の管理）。
	// この approve がないと、saved workspace を持っているユーザーでも
	// renderer が workspace:set を打つと「未承認」として拒否されてしまう。
	const savedPath = getWorkspacePathFromSettings();
	if (savedPath === null) return;
	try {
		approveWorkspacePath(savedPath);
	} catch (e) {
		console.warn("[bootstrap] failed to approve saved workspace path:", e);
	}
}

app.whenReady().then(() => {
	electronApp.setAppUserModelId("com.scripta.app");
	registerIpcHandlers();
	setApplicationMenu({ newWindow: () => createWindow({ newWindow: true }) });
	approveSavedWorkspaceFromSettings();
	const cspTargetUrls = process.env.ELECTRON_RENDERER_URL
		? [`${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, "")}/*`]
		: ["file:///*"];
	session.defaultSession.webRequest.onHeadersReceived(
		{ urls: cspTargetUrls },
		(details, callback) => {
			const cleaned = Object.fromEntries(
				Object.entries(details.responseHeaders ?? {}).filter(
					([name]) => name.toLowerCase() !== "content-security-policy",
				),
			);
			callback({
				responseHeaders: {
					...cleaned,
					"Content-Security-Policy": [is.dev ? CSP_DEV : CSP_PROD],
				},
			});
		},
	);
	createWindow();
});
