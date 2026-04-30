import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import type { Api } from "./api";

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
	const handler = (_event: IpcRendererEvent, payload: T) => {
		cb(payload);
	};
	ipcRenderer.on(channel, handler);
	return () => {
		ipcRenderer.removeListener(channel, handler);
	};
}

const api: Api = Object.freeze({
	getVersion: () => process.versions.electron ?? "",
	getAppVersion: () => ipcRenderer.invoke("app:get-version"),
	closeWindow: () => ipcRenderer.invoke("window:close"),
	openConflictWindow: (workspacePath) => ipcRenderer.invoke("window:open-conflict", workspacePath),
	onWindowCloseRequested: (cb) => {
		const handler = async (_event: IpcRendererEvent, requestId: number) => {
			try {
				await cb();
				ipcRenderer.send("window:close-requested-ack", requestId, true);
			} catch (error) {
				console.error("onWindowCloseRequested handler failed:", error);
				ipcRenderer.send("window:close-requested-ack", requestId, false);
			}
		};
		ipcRenderer.on("window:close-requested", handler);
		return () => {
			ipcRenderer.removeListener("window:close-requested", handler);
		};
	},
	clearWebviewBrowsingData: () => ipcRenderer.invoke("window:clear-webview-data"),

	openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
	showInFolder: (path) => ipcRenderer.invoke("shell:show-in-folder", path),
	convertFileSrc: (path) => path,

	openDirectoryPicker: () => ipcRenderer.invoke("dialog:open-directory"),
	showSaveDialog: (opts) => ipcRenderer.invoke("dialog:save", opts),

	readFile: (path) => ipcRenderer.invoke("fs:read", path),
	writeFile: (path, content) => ipcRenderer.invoke("fs:write", path, content),
	writeNewFile: (path, content) => ipcRenderer.invoke("fs:write-new", path, content),
	listDirectory: (path) => ipcRenderer.invoke("fs:list", path),
	createFile: (path) => ipcRenderer.invoke("fs:create-file", path),
	createDirectory: (path) => ipcRenderer.invoke("fs:create-directory", path),
	pathExists: (path) => ipcRenderer.invoke("fs:path-exists", path),
	fileExists: (path) => ipcRenderer.invoke("fs:file-exists", path),
	renameEntry: (oldPath, newPath) => ipcRenderer.invoke("fs:rename", oldPath, newPath),
	deleteEntry: (path) => ipcRenderer.invoke("fs:delete", path),

	startWatcher: (path) => ipcRenderer.invoke("watcher:start", path),
	stopWatcher: () => ipcRenderer.invoke("watcher:stop"),
	onFsChange: (cb) => subscribe("watcher:fs-change", cb),

	searchFiles: (workspacePath, query, caseSensitive) =>
		ipcRenderer.invoke("search:files", workspacePath, query, caseSensitive),
	searchFilenames: (workspacePath, query) =>
		ipcRenderer.invoke("search:filenames", workspacePath, query),
	scanUnresolvedWikilinks: (workspacePath) =>
		ipcRenderer.invoke("search:unresolved-wikilinks", workspacePath),

	fetchOgp: (url) => ipcRenderer.invoke("ogp:fetch", url),
	exportPdf: (html, outputPath) => ipcRenderer.invoke("pdf:export", html, outputPath),
	checkForUpdate: (currentVersion) => ipcRenderer.invoke("update:check", currentVersion),

	gitCheckAvailable: () => ipcRenderer.invoke("git:check-available"),
	gitCheckRepo: (path) => ipcRenderer.invoke("git:check-repo", path),
	gitStatus: (path) => ipcRenderer.invoke("git:status", path),
	gitAddAll: (path) => ipcRenderer.invoke("git:add-all", path),
	gitCommit: (path, message) => ipcRenderer.invoke("git:commit", path, message),
	gitPull: (path, syncMethod) => ipcRenderer.invoke("git:pull", path, syncMethod),
	gitPush: (path) => ipcRenderer.invoke("git:push", path),
	gitGetConflictedFiles: (path) => ipcRenderer.invoke("git:get-conflicted-files", path),
	gitGetConflictContent: (path, filePath) =>
		ipcRenderer.invoke("git:get-conflict-content", path, filePath),
	gitResolveConflict: (path, filePath, content, resolution) =>
		ipcRenderer.invoke("git:resolve-conflict", path, filePath, content, resolution),
	gitFinishConflictResolution: (path) => ipcRenderer.invoke("git:finish-conflict-resolution", path),
	gitGetLastCommitTime: (path) => ipcRenderer.invoke("git:get-last-commit-time", path),
	emitConflictResolved: () => ipcRenderer.invoke("git:emit-conflict-resolved"),
	onConflictResolved: (cb) => subscribe<void>("git:conflict-resolved", () => cb()),

	onMenuEvent: (name, cb) => subscribe<void>(`menu:${name}`, () => cb()),

	settingsGet: (key) => ipcRenderer.invoke("settings:get", key),
	settingsSet: (key, value) => ipcRenderer.invoke("settings:set", key, value),
	settingsDelete: (key) => ipcRenderer.invoke("settings:delete", key),
	settingsSave: () => ipcRenderer.invoke("settings:save"),
});

contextBridge.exposeInMainWorld("electron", electronAPI);
contextBridge.exposeInMainWorld("api", api);
