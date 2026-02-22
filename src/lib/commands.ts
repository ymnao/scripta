import { invoke } from "@tauri-apps/api/core";
import type { SearchResult } from "../types/search";
import type { FileEntry } from "../types/workspace";

export function readFile(path: string): Promise<string> {
	return invoke<string>("read_file", { path });
}

export function writeFile(path: string, content: string): Promise<void> {
	return invoke<void>("write_file", { path, content });
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
