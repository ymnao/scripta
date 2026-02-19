import { invoke } from "@tauri-apps/api/core";
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
