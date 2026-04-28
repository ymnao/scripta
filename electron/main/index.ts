import { join } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, shell } from "electron";

function isSafeExternalUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
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

	mainWindow.on("ready-to-show", () => {
		mainWindow.show();
	});

	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (isSafeExternalUrl(url)) shell.openExternal(url);
		return { action: "deny" };
	});

	mainWindow.webContents.on("will-navigate", (event, url) => {
		const currentUrl = mainWindow.webContents.getURL();
		if (!currentUrl) return;
		try {
			const target = new URL(url);
			const current = new URL(currentUrl);
			if (target.origin !== current.origin) event.preventDefault();
		} catch {
			event.preventDefault();
		}
	});

	if (process.env.ELECTRON_RENDERER_URL) {
		mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
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
	createWindow();
});
