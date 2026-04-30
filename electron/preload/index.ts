import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";
import type { ConflictContent, GitStatus, SyncMethod } from "../../src/types/git-sync";
import type { OgpData } from "../../src/types/ogp";
import type { SearchResult } from "../../src/types/search";
import type { UpdateInfo } from "../../src/types/update";
import type { UnresolvedWikilink } from "../../src/types/wikilink";
import type { FileEntry, FsChangeEvent } from "../../src/types/workspace";
import type { Api, MenuEventName, SaveDialogOptions } from "./api";

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
	getAppVersion: () => ipcRenderer.invoke("app:get-version") as Promise<string>,
	closeWindow: () => ipcRenderer.invoke("window:close") as Promise<void>,
	openConflictWindow: (workspacePath: string) =>
		ipcRenderer.invoke("window:open-conflict", workspacePath) as Promise<void>,
	onWindowCloseRequested: (cb) => {
		const handler = async (event: IpcRendererEvent, requestId: number) => {
			try {
				await cb();
				ipcRenderer.send("window:close-requested-ack", requestId, true);
			} catch (error) {
				console.error("onWindowCloseRequested handler failed:", error);
				ipcRenderer.send("window:close-requested-ack", requestId, false);
			}
			void event;
		};
		ipcRenderer.on("window:close-requested", handler);
		return () => {
			ipcRenderer.removeListener("window:close-requested", handler);
		};
	},
	clearWebviewBrowsingData: () => ipcRenderer.invoke("window:clear-webview-data") as Promise<void>,

	openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url) as Promise<void>,
	showInFolder: (path: string) => ipcRenderer.invoke("shell:show-in-folder", path) as Promise<void>,
	convertFileSrc: (path: string) => path,

	openDirectoryPicker: () => ipcRenderer.invoke("dialog:open-directory") as Promise<string | null>,
	showSaveDialog: (opts: SaveDialogOptions) =>
		ipcRenderer.invoke("dialog:save", opts) as Promise<string | null>,

	readFile: (path: string) => ipcRenderer.invoke("fs:read", path) as Promise<string>,
	writeFile: (path: string, content: string) =>
		ipcRenderer.invoke("fs:write", path, content) as Promise<void>,
	writeNewFile: (path: string, content: string) =>
		ipcRenderer.invoke("fs:write-new", path, content) as Promise<void>,
	listDirectory: (path: string) => ipcRenderer.invoke("fs:list", path) as Promise<FileEntry[]>,
	createFile: (path: string) => ipcRenderer.invoke("fs:create-file", path) as Promise<void>,
	createDirectory: (path: string) =>
		ipcRenderer.invoke("fs:create-directory", path) as Promise<void>,
	pathExists: (path: string) => ipcRenderer.invoke("fs:path-exists", path) as Promise<boolean>,
	fileExists: (path: string) => ipcRenderer.invoke("fs:file-exists", path) as Promise<boolean>,
	renameEntry: (oldPath: string, newPath: string) =>
		ipcRenderer.invoke("fs:rename", oldPath, newPath) as Promise<void>,
	deleteEntry: (path: string) => ipcRenderer.invoke("fs:delete", path) as Promise<void>,

	startWatcher: (path: string) => ipcRenderer.invoke("watcher:start", path) as Promise<void>,
	stopWatcher: () => ipcRenderer.invoke("watcher:stop") as Promise<void>,
	onFsChange: (cb) => subscribe<FsChangeEvent[]>("watcher:fs-change", cb),

	searchFiles: (workspacePath: string, query: string, caseSensitive?: boolean) =>
		ipcRenderer.invoke("search:files", workspacePath, query, caseSensitive) as Promise<
			SearchResult[]
		>,
	searchFilenames: (workspacePath: string, query: string) =>
		ipcRenderer.invoke("search:filenames", workspacePath, query) as Promise<string[]>,
	scanUnresolvedWikilinks: (workspacePath: string) =>
		ipcRenderer.invoke("search:unresolved-wikilinks", workspacePath) as Promise<
			UnresolvedWikilink[]
		>,

	fetchOgp: (url: string) => ipcRenderer.invoke("ogp:fetch", url) as Promise<OgpData>,
	exportPdf: (html: string, outputPath: string) =>
		ipcRenderer.invoke("pdf:export", html, outputPath) as Promise<void>,
	checkForUpdate: (currentVersion: string) =>
		ipcRenderer.invoke("update:check", currentVersion) as Promise<UpdateInfo>,

	gitCheckAvailable: () => ipcRenderer.invoke("git:check-available") as Promise<boolean>,
	gitCheckRepo: (path: string) => ipcRenderer.invoke("git:check-repo", path) as Promise<boolean>,
	gitStatus: (path: string) => ipcRenderer.invoke("git:status", path) as Promise<GitStatus>,
	gitAddAll: (path: string) => ipcRenderer.invoke("git:add-all", path) as Promise<void>,
	gitCommit: (path: string, message: string) =>
		ipcRenderer.invoke("git:commit", path, message) as Promise<string>,
	gitPull: (path: string, syncMethod: SyncMethod) =>
		ipcRenderer.invoke("git:pull", path, syncMethod) as Promise<string>,
	gitPush: (path: string) => ipcRenderer.invoke("git:push", path) as Promise<string>,
	gitGetConflictedFiles: (path: string) =>
		ipcRenderer.invoke("git:get-conflicted-files", path) as Promise<string[]>,
	gitGetConflictContent: (path: string, filePath: string) =>
		ipcRenderer.invoke("git:get-conflict-content", path, filePath) as Promise<ConflictContent>,
	gitResolveConflict: (
		path: string,
		filePath: string,
		content: string,
		resolution: "modify" | "delete",
	) =>
		ipcRenderer.invoke(
			"git:resolve-conflict",
			path,
			filePath,
			content,
			resolution,
		) as Promise<void>,
	gitFinishConflictResolution: (path: string) =>
		ipcRenderer.invoke("git:finish-conflict-resolution", path) as Promise<string>,
	gitGetLastCommitTime: (path: string) =>
		ipcRenderer.invoke("git:get-last-commit-time", path) as Promise<string | null>,
	emitConflictResolved: () => ipcRenderer.invoke("git:emit-conflict-resolved") as Promise<void>,
	onConflictResolved: (cb) => subscribe<void>("git:conflict-resolved", () => cb()),

	onMenuEvent: (name: MenuEventName, cb) => subscribe<void>(`menu:${name}`, () => cb()),

	settingsGet: (key: string) => ipcRenderer.invoke("settings:get", key) as Promise<unknown>,
	settingsSet: (key: string, value: unknown) =>
		ipcRenderer.invoke("settings:set", key, value) as Promise<void>,
	settingsDelete: (key: string) => ipcRenderer.invoke("settings:delete", key) as Promise<void>,
	settingsSave: () => ipcRenderer.invoke("settings:save") as Promise<void>,
});

contextBridge.exposeInMainWorld("electron", electronAPI);
contextBridge.exposeInMainWorld("api", api);
