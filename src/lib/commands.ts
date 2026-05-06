import type { MenuEventName, SaveDialogOptions } from "../../electron/preload/api";
import type { ConflictContent, GitStatus, SyncMethod } from "../types/git-sync";
import type { OgpData } from "../types/ogp";
import type { SearchResult } from "../types/search";
import type { UpdateInfo } from "../types/update";
import type { UnresolvedWikilink } from "../types/wikilink";
import type { FileEntry, FsChangeEvent } from "../types/workspace";
import { isTransientError } from "./errors";

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, baseDelayMs = 200): Promise<T> {
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (!isTransientError(error) || attempt === maxRetries) throw error;
			await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
		}
	}
	throw new Error("unreachable");
}

export function readFile(path: string): Promise<string> {
	return withRetry(() => window.api.readFile(path));
}

export function writeFile(path: string, content: string): Promise<void> {
	return withRetry(() => window.api.writeFile(path, content));
}

export function listDirectory(path: string): Promise<FileEntry[]> {
	return withRetry(() => window.api.listDirectory(path));
}

export function createFile(path: string): Promise<void> {
	return window.api.createFile(path);
}

export function createDirectory(path: string): Promise<void> {
	return window.api.createDirectory(path);
}

export function writeNewFile(path: string, content: string): Promise<void> {
	return window.api.writeNewFile(path, content);
}

export function pathExists(path: string): Promise<boolean> {
	return window.api.pathExists(path);
}

export function fileExists(path: string): Promise<boolean> {
	return window.api.fileExists(path);
}

export function renameEntry(oldPath: string, newPath: string): Promise<void> {
	return withRetry(() => window.api.renameEntry(oldPath, newPath));
}

export function deleteEntry(path: string): Promise<void> {
	return withRetry(() => window.api.deleteEntry(path));
}

export function startWatcher(path: string): Promise<void> {
	return window.api.startWatcher(path);
}

export function stopWatcher(): Promise<void> {
	return window.api.stopWatcher();
}

export function searchFiles(
	workspacePath: string,
	query: string,
	caseSensitive?: boolean,
): Promise<SearchResult[]> {
	return withRetry(() => window.api.searchFiles(workspacePath, query, caseSensitive));
}

// in-flight searchFiles を main 側でキャンセルする。SearchPanel の useEffect
// cleanup から呼ばれ、空クエリ / panel unmount / workspace 切替の各ケースで
// 走り切ろうとしている全文検索を bail させる。fire-and-forget。
export function cancelSearch(): Promise<void> {
	return window.api.cancelSearch();
}

export function searchFilenames(workspacePath: string, query: string): Promise<string[]> {
	return withRetry(() => window.api.searchFilenames(workspacePath, query));
}

export function scanUnresolvedWikilinks(workspacePath: string): Promise<UnresolvedWikilink[]> {
	return withRetry(() => window.api.scanUnresolvedWikilinks(workspacePath));
}

export function showInFolder(path: string): Promise<void> {
	return window.api.showInFolder(path);
}

export function fetchOgp(url: string): Promise<OgpData> {
	return window.api.fetchOgp(url);
}

export function exportPdf(html: string, outputPath: string): Promise<void> {
	return window.api.exportPdf(html, outputPath);
}

export function openExternal(url: string): Promise<void> {
	return window.api.openExternal(url);
}

export function gitCheckAvailable(): Promise<boolean> {
	return window.api.gitCheckAvailable();
}

export function gitCheckRepo(path: string): Promise<boolean> {
	return window.api.gitCheckRepo(path);
}

export function gitStatus(path: string): Promise<GitStatus> {
	return window.api.gitStatus(path);
}

export function gitAddAll(path: string): Promise<void> {
	return window.api.gitAddAll(path);
}

export function gitCommit(path: string, message: string): Promise<string> {
	return window.api.gitCommit(path, message);
}

export function gitPull(path: string, syncMethod: SyncMethod): Promise<string> {
	return window.api.gitPull(path, syncMethod);
}

export function gitPush(path: string): Promise<string> {
	return window.api.gitPush(path);
}

export function gitGetConflictedFiles(path: string): Promise<string[]> {
	return window.api.gitGetConflictedFiles(path);
}

export function gitGetConflictContent(path: string, filePath: string): Promise<ConflictContent> {
	return window.api.gitGetConflictContent(path, filePath);
}

export function gitResolveConflict(
	path: string,
	filePath: string,
	content: string,
	resolution: "modify" | "delete",
): Promise<void> {
	return window.api.gitResolveConflict(path, filePath, content, resolution);
}

export function gitFinishConflictResolution(path: string): Promise<string> {
	return window.api.gitFinishConflictResolution(path);
}

export function gitGetLastCommitTime(path: string): Promise<string | null> {
	return window.api.gitGetLastCommitTime(path);
}

export function checkForUpdate(currentVersion: string): Promise<UpdateInfo> {
	return window.api.checkForUpdate(currentVersion);
}

export function clearWebviewBrowsingData(): Promise<void> {
	return window.api.clearWebviewBrowsingData();
}

export function getAppVersion(): Promise<string> {
	return window.api.getAppVersion();
}

export function closeWindow(): Promise<void> {
	return window.api.closeWindow();
}

export function openConflictWindow(workspacePath: string): Promise<void> {
	return window.api.openConflictWindow(workspacePath);
}

export function convertFileSrc(path: string): string {
	return window.api.convertFileSrc(path);
}

export function openDirectoryPicker(): Promise<string | null> {
	return window.api.openDirectoryPicker();
}

export function showSaveDialog(opts: SaveDialogOptions): Promise<string | null> {
	return window.api.showSaveDialog(opts);
}

export function workspaceSet(path: string | null): Promise<void> {
	return window.api.workspaceSet(path);
}

export function emitConflictResolved(workspacePath: string): Promise<void> {
	return window.api.emitConflictResolved(workspacePath);
}

export function onFsChange(cb: (events: FsChangeEvent[]) => void): () => void {
	return window.api.onFsChange(cb);
}

export function onConflictResolved(cb: (workspacePath: string) => void): () => void {
	return window.api.onConflictResolved(cb);
}

export function onMenuEvent(name: MenuEventName, cb: () => void): () => void {
	return window.api.onMenuEvent(name, cb);
}

export function onWindowCloseRequested(cb: () => void | Promise<void>): () => void {
	return window.api.onWindowCloseRequested(cb);
}
