import { join } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, session, shell } from "electron";

const CSP_PROD =
	"default-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self';";
const CSP_DEV =
	"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* http://localhost:*; object-src 'none'; base-uri 'self';";

const RENDERER_FILE_DIR = join(__dirname, "../renderer");
const openWindows = new Set<BrowserWindow>();

function isSafeExternalUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	} catch {
		return false;
	}
}

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

	mainWindow.on("closed", () => {
		openWindows.delete(mainWindow);
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
