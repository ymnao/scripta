import { join } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, shell } from "electron";

function createWindow(): void {
	const window = new BrowserWindow({
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

	window.on("ready-to-show", () => {
		window.show();
	});

	window.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});

	if (is.dev && process.env.ELECTRON_RENDERER_URL) {
		window.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		window.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

app.whenReady().then(() => {
	electronApp.setAppUserModelId("dev.scripta");

	app.on("browser-window-created", (_, window) => {
		optimizer.watchWindowShortcuts(window);
	});

	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
