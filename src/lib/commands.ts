/**
 * Renderer 側の IPC client 層。preload の contextBridge が公開する `window.api`
 * （唯一の renderer↔main 境界）を呼ぶ薄いラッパーを 1 箇所に集約する。
 *
 * この層が存在する理由は 2 つ:
 * 1. **transport との疎結合** — renderer の各モジュールが preload API（`window.api`）の
 *    形状に直接依存しないようにし、IPC の呼び出し面を本ファイルに局所化する。
 * 2. **IPC 横断の関心事の chokepoint** — 現状は transient error に対する retry
 *    （`withRetry`）。将来 logging / error 変換等を足す場合もここが差し込み口になる。
 *
 * 関数の分類:
 * - **retry あり**（`withRetry` でラップ）: timeout / 一時的ロック等の transient error
 *   が起き得る fs / 全文検索系 — `readFile` / `writeFile` / `listDirectory` /
 *   `renameEntry` / `deleteEntry` / `searchFiles` / `searchFilenames` /
 *   `scanUnresolvedWikilinks`。
 * - **retry なし**（`window.api.*` への 1:1 typed forward）: 上記以外。retry が
 *   無益（冪等でない write / イベント購読）か、即時失敗で十分なもの。
 *
 * Electron では `window.api` 自体が typed な境界であるため、本層の存在価値は
 * 上記 2 点（疎結合 + retry）にある。retry なし forward を呼び出し元へ inline
 * せず本層に残す設計判断の経緯と根拠は ADR-0007 を参照。
 */
import type {
	ListDirectoryOptions,
	MenuEventName,
	SaveDialogOptions,
} from "../../electron/preload/api";
import type { ConflictContent, GitStatus, SyncMethod } from "../types/git-sync";
import type { OgpData } from "../types/ogp";
import type { SearchResult } from "../types/search";
import type { UpdateInfo } from "../types/update";
import type { BacklinkSource, UnresolvedWikilink } from "../types/wikilink";
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

export function listDirectory(path: string, opts?: ListDirectoryOptions): Promise<FileEntry[]> {
	return withRetry(() => window.api.listDirectory(path, opts));
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

// in-flight scanUnresolvedWikilinks を main 側でキャンセルする。
// UnresolvedLinksPanel の useEffect cleanup から呼ばれる。
// SearchPanel の検索を巻き込まないために cancelSearch とは別 IPC。
export function cancelWikilinkScan(): Promise<void> {
	return window.api.cancelWikilinkScan();
}

export function scanBacklinks(
	workspacePath: string,
	targetFilePath: string,
): Promise<BacklinkSource[]> {
	return withRetry(() => window.api.scanBacklinks(workspacePath, targetFilePath));
}

// in-flight scanBacklinks を main 側でキャンセルする。
// BacklinkPanel の cleanup / target file 切替時に呼ばれる。
// scanUnresolvedWikilinks / searchFiles を巻き込まない（クロスキャンセル防止）。
export function cancelBacklinkScan(): Promise<void> {
	return window.api.cancelBacklinkScan();
}

export function showInFolder(path: string): Promise<void> {
	return window.api.showInFolder(path);
}

// renderer が unique な requestId を生成して渡す。後発 fetch を誤 abort しないよう、
// cancel は requestId 単位で行う（同一 URL の多重 fetch が並走しても干渉しない）。
export function fetchOgp(requestId: string, url: string): Promise<OgpData> {
	return window.api.fetchOgp(requestId, url);
}

export function cancelOgpFetch(requestId: string): Promise<void> {
	return window.api.ogpCancel(requestId);
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

export function buildAssetUrl(path: string): string {
	return window.api.buildAssetUrl(path);
}

export function settingsGet(key: string): Promise<unknown> {
	return window.api.settingsGet(key);
}

export function settingsSet(key: string, value: unknown): Promise<void> {
	return window.api.settingsSet(key, value);
}

export function settingsDelete(key: string): Promise<void> {
	return window.api.settingsDelete(key);
}

export function settingsSave(): Promise<void> {
	return window.api.settingsSave();
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

export function onWorkspaceReloadTree(cb: () => void): () => void {
	return window.api.onWorkspaceReloadTree(cb);
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
