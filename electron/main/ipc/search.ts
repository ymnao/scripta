import { ipcMain } from "electron";
import type { SearchResult } from "../../../src/types/search";
import type { UnresolvedWikilink } from "../../../src/types/wikilink";

export function registerSearchIpc(): void {
	ipcMain.handle(
		"search:files",
		async (
			_event,
			_workspacePath: string,
			_query: string,
			_caseSensitive?: boolean,
		): Promise<SearchResult[]> => [],
	);
	ipcMain.handle(
		"search:filenames",
		async (_event, _workspacePath: string, _query: string): Promise<string[]> => [],
	);
	ipcMain.handle(
		"search:unresolved-wikilinks",
		async (_event, _workspacePath: string): Promise<UnresolvedWikilink[]> => [],
	);
}
