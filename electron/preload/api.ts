import type { ConflictContent, GitStatus, SyncMethod } from "../../src/types/git-sync";
import type { OgpData } from "../../src/types/ogp";
import type { PdfPageBreakOptions } from "../../src/types/pdf";
import type { SearchResult } from "../../src/types/search";
import type { UpdateInfo } from "../../src/types/update";
import type { UnresolvedWikilink } from "../../src/types/wikilink";
import type { FileEntry, FsChangeEvent } from "../../src/types/workspace";

export type SaveDialogOptions = {
	defaultPath?: string;
	filters?: Array<{ name: string; extensions: string[] }>;
};

// FileTree 専用 opt-in。設定 fileTreeShowHidden / fileTreeExcludePatterns を main 側で適用する。
// DirectoryPicker / config 用ディレクトリ scan など、FileTree 以外の listDirectory では指定しない。
export type ListDirectoryOptions = {
	applyFileTreeFilter?: boolean;
};

export type Unsubscribe = () => void;

export type MenuEventName = "open-settings" | "open-help" | "export";

export type Api = Readonly<{
	getAppVersion: () => Promise<string>;
	closeWindow: () => Promise<void>;
	openConflictWindow: (workspacePath: string) => Promise<void>;
	onWindowCloseRequested: (cb: () => void | Promise<void>) => Unsubscribe;
	clearWebviewBrowsingData: () => Promise<void>;

	openExternal: (url: string) => Promise<void>;
	showInFolder: (path: string) => Promise<void>;
	buildAssetUrl: (path: string) => string;

	openDirectoryPicker: () => Promise<string | null>;
	showSaveDialog: (opts: SaveDialogOptions) => Promise<string | null>;

	workspaceSet: (path: string | null) => Promise<void>;

	readFile: (path: string) => Promise<string>;
	writeFile: (path: string, content: string) => Promise<void>;
	writeNewFile: (path: string, content: string) => Promise<void>;
	listDirectory: (path: string, opts?: ListDirectoryOptions) => Promise<FileEntry[]>;
	createFile: (path: string) => Promise<void>;
	createDirectory: (path: string) => Promise<void>;
	pathExists: (path: string) => Promise<boolean>;
	fileExists: (path: string) => Promise<boolean>;
	renameEntry: (oldPath: string, newPath: string) => Promise<void>;
	deleteEntry: (path: string) => Promise<void>;

	startWatcher: (path: string) => Promise<void>;
	stopWatcher: () => Promise<void>;
	onFsChange: (cb: (events: FsChangeEvent[]) => void) => Unsubscribe;
	onWorkspaceReloadTree: (cb: () => void) => Unsubscribe;

	searchFiles: (
		workspacePath: string,
		query: string,
		caseSensitive?: boolean,
	) => Promise<SearchResult[]>;
	cancelSearch: () => Promise<void>;
	searchFilenames: (workspacePath: string, query: string) => Promise<string[]>;
	scanUnresolvedWikilinks: (workspacePath: string) => Promise<UnresolvedWikilink[]>;
	cancelWikilinkScan: () => Promise<void>;

	fetchOgp: (url: string) => Promise<OgpData>;
	exportPdf: (html: string, outputPath: string, pageBreak?: PdfPageBreakOptions) => Promise<void>;
	checkForUpdate: (currentVersion: string) => Promise<UpdateInfo>;

	gitCheckAvailable: () => Promise<boolean>;
	gitCheckRepo: (path: string) => Promise<boolean>;
	gitStatus: (path: string) => Promise<GitStatus>;
	gitAddAll: (path: string) => Promise<void>;
	gitCommit: (path: string, message: string) => Promise<string>;
	gitPull: (path: string, syncMethod: SyncMethod) => Promise<string>;
	gitPush: (path: string) => Promise<string>;
	gitGetConflictedFiles: (path: string) => Promise<string[]>;
	gitGetConflictContent: (path: string, filePath: string) => Promise<ConflictContent>;
	gitResolveConflict: (
		path: string,
		filePath: string,
		content: string,
		resolution: "modify" | "delete",
	) => Promise<void>;
	gitFinishConflictResolution: (path: string) => Promise<string>;
	gitGetLastCommitTime: (path: string) => Promise<string | null>;
	emitConflictResolved: (workspacePath: string) => Promise<void>;
	onConflictResolved: (cb: (workspacePath: string) => void) => Unsubscribe;

	onMenuEvent: (name: MenuEventName, cb: () => void) => Unsubscribe;

	settingsGet: (key: string) => Promise<unknown>;
	settingsSet: (key: string, value: unknown) => Promise<void>;
	settingsDelete: (key: string) => Promise<void>;
	settingsSave: () => Promise<void>;
}>;
