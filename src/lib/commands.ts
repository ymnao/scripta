import { invoke } from "@tauri-apps/api/core";
import type { ConflictContent, GitStatus, SyncMethod } from "../types/git-sync";
import type { OgpData } from "../types/ogp";
import type { SearchResult } from "../types/search";
import type { FileEntry } from "../types/workspace";
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
	return withRetry(() => invoke<string>("read_file", { path }));
}

export function writeFile(path: string, content: string): Promise<void> {
	return withRetry(() => invoke<void>("write_file", { path, content }));
}

export function listDirectory(path: string): Promise<FileEntry[]> {
	return invoke<FileEntry[]>("list_directory", { path });
}

export function createFile(path: string): Promise<void> {
	return invoke<void>("create_file", { path });
}

export function createDirectory(path: string): Promise<void> {
	return invoke<void>("create_directory", { path });
}

export function writeNewFile(path: string, content: string): Promise<void> {
	return invoke<void>("write_new_file", { path, content });
}

export function pathExists(path: string): Promise<boolean> {
	return invoke<boolean>("path_exists", { path });
}

export function fileExists(path: string): Promise<boolean> {
	return invoke<boolean>("file_exists", { path });
}

export function renameEntry(oldPath: string, newPath: string): Promise<void> {
	return invoke<void>("rename_entry", { oldPath, newPath });
}

export function deleteEntry(path: string): Promise<void> {
	return invoke<void>("delete_entry", { path });
}

export function startWatcher(path: string): Promise<void> {
	return invoke<void>("start_watcher", { path });
}

export function stopWatcher(): Promise<void> {
	return invoke<void>("stop_watcher");
}

export function searchFiles(
	workspacePath: string,
	query: string,
	caseSensitive?: boolean,
): Promise<SearchResult[]> {
	return invoke<SearchResult[]>("search_files", { workspacePath, query, caseSensitive });
}

export function searchFilenames(workspacePath: string, query: string): Promise<string[]> {
	return invoke<string[]>("search_filenames", { workspacePath, query });
}

export function showInFolder(path: string): Promise<void> {
	return invoke<void>("show_in_folder", { path });
}

export function fetchOgp(url: string): Promise<OgpData> {
	return invoke<OgpData>("fetch_ogp", { url });
}

export function exportPdf(html: string, outputPath: string): Promise<void> {
	return invoke<void>("export_pdf", { html, outputPath });
}

// Git sync commands (no retry — git operations should not be retried)

export function gitCheckAvailable(): Promise<boolean> {
	return invoke<boolean>("git_check_available");
}

export function gitCheckRepo(path: string): Promise<boolean> {
	return invoke<boolean>("git_check_repo", { path });
}

export function gitStatus(path: string): Promise<GitStatus> {
	return invoke<GitStatus>("git_status", { path });
}

export function gitAddAll(path: string): Promise<void> {
	return invoke<void>("git_add_all", { path });
}

export function gitCommit(path: string, message: string): Promise<string> {
	return invoke<string>("git_commit", { path, message });
}

export function gitPull(path: string, syncMethod: SyncMethod): Promise<string> {
	return invoke<string>("git_pull", { path, syncMethod });
}

export function gitPush(path: string): Promise<string> {
	return invoke<string>("git_push", { path });
}

export function gitUnpushedCount(path: string): Promise<number> {
	return invoke<number>("git_unpushed_count", { path });
}

export function gitGetConflictedFiles(path: string): Promise<string[]> {
	return invoke<string[]>("git_get_conflicted_files", { path });
}

export function gitGetConflictContent(path: string, filePath: string): Promise<ConflictContent> {
	return invoke<ConflictContent>("git_get_conflict_content", { path, filePath });
}

export function gitResolveConflict(
	path: string,
	filePath: string,
	content: string,
	resolution: "modify" | "delete",
): Promise<void> {
	return invoke<void>("git_resolve_conflict", { path, filePath, content, resolution });
}

export function gitGetLastCommitTime(path: string): Promise<string | null> {
	return invoke<string | null>("git_get_last_commit_time", { path });
}
