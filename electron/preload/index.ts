import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import type { Api } from "./api";
import { invokeWithStructuredError as invoke } from "./ipc-error-decode";
import { buildScriptaAssetUrl } from "./scripta-asset-url";

// `invoke(ipcRenderer.invoke(...))` で全 IPC 呼び出しをラップする。main 側 handle() が
// 構造化したエラーを preload で unmarshal し、renderer へ kind 付き Error として伝える。
// 成功 path は invoke の戻り値をそのまま透過する（ipcRenderer.invoke は any 返しのため
// Api の各メソッドの戻り型はそのまま保たれる）。

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
	getAppVersion: () => invoke(ipcRenderer.invoke("app:get-version")),
	closeWindow: () => invoke(ipcRenderer.invoke("window:close")),
	openConflictWindow: (workspacePath) =>
		invoke(ipcRenderer.invoke("window:open-conflict", workspacePath)),
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
	clearWebviewBrowsingData: () => invoke(ipcRenderer.invoke("window:clear-webview-data")),

	openExternal: (url) => invoke(ipcRenderer.invoke("shell:open-external", url)),
	showInFolder: (path) => invoke(ipcRenderer.invoke("shell:show-in-folder", path)),
	buildAssetUrl: (path) => buildScriptaAssetUrl(path),

	openDirectoryPicker: () => invoke(ipcRenderer.invoke("dialog:open-directory")),
	showSaveDialog: (opts) => invoke(ipcRenderer.invoke("dialog:save", opts)),

	workspaceSet: (path) => invoke(ipcRenderer.invoke("workspace:set", path)),

	readFile: (path) => invoke(ipcRenderer.invoke("fs:read", path)),
	writeFile: (path, content) => invoke(ipcRenderer.invoke("fs:write", path, content)),
	writeNewFile: (path, content) => invoke(ipcRenderer.invoke("fs:write-new", path, content)),
	listDirectory: (path, opts) => invoke(ipcRenderer.invoke("fs:list", path, opts)),
	createFile: (path) => invoke(ipcRenderer.invoke("fs:create-file", path)),
	createDirectory: (path) => invoke(ipcRenderer.invoke("fs:create-directory", path)),
	pathExists: (path) => invoke(ipcRenderer.invoke("fs:path-exists", path)),
	fileExists: (path) => invoke(ipcRenderer.invoke("fs:file-exists", path)),
	renameEntry: (oldPath, newPath) => invoke(ipcRenderer.invoke("fs:rename", oldPath, newPath)),
	deleteEntry: (path) => invoke(ipcRenderer.invoke("fs:delete", path)),

	startWatcher: (path) => invoke(ipcRenderer.invoke("watcher:start", path)),
	stopWatcher: () => invoke(ipcRenderer.invoke("watcher:stop")),
	onFsChange: (cb) => subscribe("watcher:fs-change", cb),
	onWorkspaceReloadTree: (cb) => subscribe<void>("workspace:reload-tree", () => cb()),

	searchFiles: (workspacePath, query, caseSensitive) =>
		invoke(ipcRenderer.invoke("search:files", workspacePath, query, caseSensitive)),
	cancelSearch: () => invoke(ipcRenderer.invoke("search:cancel")),
	searchFilenames: (workspacePath, query) =>
		invoke(ipcRenderer.invoke("search:filenames", workspacePath, query)),
	scanUnresolvedWikilinks: (workspacePath) =>
		invoke(ipcRenderer.invoke("search:unresolved-wikilinks", workspacePath)),
	cancelWikilinkScan: () => invoke(ipcRenderer.invoke("wikilink:cancel")),

	fetchOgp: (url) => invoke(ipcRenderer.invoke("ogp:fetch", url)),
	exportPdf: (html, outputPath, pageBreak) =>
		invoke(ipcRenderer.invoke("pdf:export", html, outputPath, pageBreak)),
	checkForUpdate: (currentVersion) => invoke(ipcRenderer.invoke("update:check", currentVersion)),

	gitCheckAvailable: () => invoke(ipcRenderer.invoke("git:check-available")),
	gitCheckRepo: (path) => invoke(ipcRenderer.invoke("git:check-repo", path)),
	gitStatus: (path) => invoke(ipcRenderer.invoke("git:status", path)),
	gitAddAll: (path) => invoke(ipcRenderer.invoke("git:add-all", path)),
	gitCommit: (path, message) => invoke(ipcRenderer.invoke("git:commit", path, message)),
	gitPull: (path, syncMethod) => invoke(ipcRenderer.invoke("git:pull", path, syncMethod)),
	gitPush: (path) => invoke(ipcRenderer.invoke("git:push", path)),
	gitGetConflictedFiles: (path) => invoke(ipcRenderer.invoke("git:get-conflicted-files", path)),
	gitGetConflictContent: (path, filePath) =>
		invoke(ipcRenderer.invoke("git:get-conflict-content", path, filePath)),
	gitResolveConflict: (path, filePath, content, resolution) =>
		invoke(ipcRenderer.invoke("git:resolve-conflict", path, filePath, content, resolution)),
	gitFinishConflictResolution: (path) =>
		invoke(ipcRenderer.invoke("git:finish-conflict-resolution", path)),
	gitGetLastCommitTime: (path) => invoke(ipcRenderer.invoke("git:get-last-commit-time", path)),
	emitConflictResolved: (workspacePath) =>
		invoke(ipcRenderer.invoke("git:emit-conflict-resolved", workspacePath)),
	onConflictResolved: (cb) => subscribe<string>("git:conflict-resolved", (path) => cb(path)),

	onMenuEvent: (name, cb) => subscribe<void>(`menu:${name}`, () => cb()),

	settingsGet: (key) => invoke(ipcRenderer.invoke("settings:get", key)),
	settingsSet: (key, value) => invoke(ipcRenderer.invoke("settings:set", key, value)),
	settingsDelete: (key) => invoke(ipcRenderer.invoke("settings:delete", key)),
	settingsSave: () => invoke(ipcRenderer.invoke("settings:save")),
});

contextBridge.exposeInMainWorld("electron", electronAPI);
contextBridge.exposeInMainWorld("api", api);
