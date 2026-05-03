import { join } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, session, shell } from "electron";
import { registerIpcHandlers } from "./ipc";
import { unregisterWindow } from "./ipc/workspace";
import { isSafeExternalUrl } from "./utils/url";

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

function createWindow(): void {
	const mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
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

	mainWindow.on("ready-to-show", () => {
		mainWindow.show();
	});

	const closingWindowId = mainWindow.webContents.id;
	mainWindow.on("closed", () => {
		openWindows.delete(mainWindow);
		// このウィンドウだけが使っていた workspace path は allowedRoots からも消える
		unregisterWindow(closingWindowId);
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

	if (process.env.ELECTRON_RENDERER_URL) {
		void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL).catch((error) => {
			console.error("Failed to load renderer URL:", error);
		});
	} else {
		void mainWindow.loadFile(join(__dirname, "../renderer/index.html")).catch((error) => {
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

app.whenReady().then(() => {
	electronApp.setAppUserModelId("dev.scripta");
	registerIpcHandlers();
	// workspace の登録は renderer 側 AppLayout が settings から読み込んだ workspacePath を
	// workspaceSet で申告した時点で行う（window 単位の管理のため、ここでは bootstrap しない）
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
