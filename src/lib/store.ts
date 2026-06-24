import { DEFAULT_FILE_TREE_EXCLUDE_PATTERNS } from "../types/file-tree";
import type { SyncMethod } from "../types/git-sync";
import { GIT_SYNC_DEFAULTS } from "../types/git-sync";
import { settingsDelete, settingsGet, settingsSave, settingsSet } from "./commands";
import { applyMigrations } from "./store-migration";

export { DEFAULT_FILE_TREE_EXCLUDE_PATTERNS };

export type ThemePreference = "system" | "light" | "dark";
export type FontFamily = "monospace" | "sans-serif" | "serif";

// AppSettings は UI / store 層が消費する settings の shape。`_schemaVersion` は
// storage layer 内部の concern（migration 連鎖を成立させるため settings.json には
// 書かれるが、AppSettings には surface しない）。store-migration.ts 参照。
interface AppSettings {
	workspacePath: string | null;
	themePreference: ThemePreference;
	sidebarVisible: boolean;
	showLineNumbers: boolean;
	fontSize: number;
	autoSaveDelay: number;
	highlightActiveLine: boolean;
	fontFamily: FontFamily;
	trimTrailingWhitespace: boolean;
	showLinkCards: boolean;
	gitSyncEnabled: boolean;
	autoCommitInterval: number;
	autoPullInterval: number;
	autoPushInterval: number;
	pullBeforePush: boolean;
	syncMethod: SyncMethod;
	commitMessage: string;
	autoPullOnStartup: boolean;
	scratchpadVolatile: boolean;
	autoUpdateCheck: boolean;
	fileTreeShowHidden: boolean;
	fileTreeExcludePatterns: string;
}

const DEFAULTS: AppSettings = {
	workspacePath: null,
	themePreference: "system",
	sidebarVisible: true,
	showLineNumbers: true,
	fontSize: 14,
	autoSaveDelay: 2000,
	highlightActiveLine: false,
	fontFamily: "monospace",
	trimTrailingWhitespace: true,
	showLinkCards: true,
	gitSyncEnabled: GIT_SYNC_DEFAULTS.gitSyncEnabled,
	autoCommitInterval: GIT_SYNC_DEFAULTS.autoCommitInterval,
	autoPullInterval: GIT_SYNC_DEFAULTS.autoPullInterval,
	autoPushInterval: GIT_SYNC_DEFAULTS.autoPushInterval,
	pullBeforePush: GIT_SYNC_DEFAULTS.pullBeforePush,
	syncMethod: GIT_SYNC_DEFAULTS.syncMethod,
	commitMessage: GIT_SYNC_DEFAULTS.commitMessage,
	autoPullOnStartup: GIT_SYNC_DEFAULTS.autoPullOnStartup,
	scratchpadVolatile: true,
	autoUpdateCheck: true,
	fileTreeShowHidden: false,
	fileTreeExcludePatterns: DEFAULT_FILE_TREE_EXCLUDE_PATTERNS,
};

export async function loadSettings(): Promise<AppSettings> {
	try {
		// 旧 → 新 schema の段階的変換。store-migration.ts の MIGRATIONS に entry を
		// 追加するだけで新規 migration を組み込める。何か適用された時のみ disk write を kick。
		const migrated = await applyMigrations({
			get: settingsGet,
			set: settingsSet,
			delete: settingsDelete,
		});
		if (migrated) {
			await settingsSave();
		}

		const rawWorkspacePath = await settingsGet("workspacePath");
		const workspacePath: string | null =
			typeof rawWorkspacePath === "string" ? rawWorkspacePath : DEFAULTS.workspacePath;

		const rawThemePreference = await settingsGet("themePreference");
		const themePreference: ThemePreference =
			rawThemePreference === "system" ||
			rawThemePreference === "light" ||
			rawThemePreference === "dark"
				? rawThemePreference
				: DEFAULTS.themePreference;

		const rawSidebarVisible = await settingsGet("sidebarVisible");
		const sidebarVisible: boolean =
			typeof rawSidebarVisible === "boolean" ? rawSidebarVisible : DEFAULTS.sidebarVisible;

		const rawShowLineNumbers = await settingsGet("showLineNumbers");
		const showLineNumbers: boolean =
			typeof rawShowLineNumbers === "boolean" ? rawShowLineNumbers : DEFAULTS.showLineNumbers;

		const rawFontSize = await settingsGet("fontSize");
		const fontSize: number =
			typeof rawFontSize === "number" && rawFontSize >= 8 && rawFontSize <= 32
				? rawFontSize
				: DEFAULTS.fontSize;

		const rawAutoSaveDelay = await settingsGet("autoSaveDelay");
		const autoSaveDelay: number =
			typeof rawAutoSaveDelay === "number" && rawAutoSaveDelay >= 500 && rawAutoSaveDelay <= 10000
				? rawAutoSaveDelay
				: DEFAULTS.autoSaveDelay;

		const rawHighlightActiveLine = await settingsGet("highlightActiveLine");
		const highlightActiveLine: boolean =
			typeof rawHighlightActiveLine === "boolean"
				? rawHighlightActiveLine
				: DEFAULTS.highlightActiveLine;

		const rawFontFamily = await settingsGet("fontFamily");
		const fontFamily: FontFamily =
			rawFontFamily === "monospace" || rawFontFamily === "sans-serif" || rawFontFamily === "serif"
				? rawFontFamily
				: DEFAULTS.fontFamily;

		const rawTrimTrailingWhitespace = await settingsGet("trimTrailingWhitespace");
		const trimTrailingWhitespace: boolean =
			typeof rawTrimTrailingWhitespace === "boolean"
				? rawTrimTrailingWhitespace
				: DEFAULTS.trimTrailingWhitespace;

		const rawShowLinkCards = await settingsGet("showLinkCards");
		const showLinkCards: boolean =
			typeof rawShowLinkCards === "boolean" ? rawShowLinkCards : DEFAULTS.showLinkCards;

		const rawGitSyncEnabled = await settingsGet("gitSyncEnabled");
		const gitSyncEnabled: boolean =
			typeof rawGitSyncEnabled === "boolean" ? rawGitSyncEnabled : DEFAULTS.gitSyncEnabled;

		const rawAutoCommitInterval = await settingsGet("autoCommitInterval");
		const autoCommitInterval: number =
			typeof rawAutoCommitInterval === "number" &&
			rawAutoCommitInterval >= 0 &&
			rawAutoCommitInterval <= 1440
				? rawAutoCommitInterval
				: DEFAULTS.autoCommitInterval;

		const rawAutoPullInterval = await settingsGet("autoPullInterval");
		const autoPullInterval: number =
			typeof rawAutoPullInterval === "number" &&
			rawAutoPullInterval >= 0 &&
			rawAutoPullInterval <= 1440
				? rawAutoPullInterval
				: DEFAULTS.autoPullInterval;

		const rawAutoPushInterval = await settingsGet("autoPushInterval");
		const autoPushInterval: number =
			typeof rawAutoPushInterval === "number" &&
			rawAutoPushInterval >= 0 &&
			rawAutoPushInterval <= 1440
				? rawAutoPushInterval
				: DEFAULTS.autoPushInterval;

		const rawPullBeforePush = await settingsGet("pullBeforePush");
		const pullBeforePush: boolean =
			typeof rawPullBeforePush === "boolean" ? rawPullBeforePush : DEFAULTS.pullBeforePush;

		const rawSyncMethod = await settingsGet("syncMethod");
		const syncMethod: SyncMethod =
			rawSyncMethod === "merge" || rawSyncMethod === "rebase" ? rawSyncMethod : DEFAULTS.syncMethod;

		const rawCommitMessage = await settingsGet("commitMessage");
		const trimmedCommitMessage =
			typeof rawCommitMessage === "string" ? rawCommitMessage.trim() : "";
		const commitMessage: string =
			trimmedCommitMessage.length > 0 ? trimmedCommitMessage : DEFAULTS.commitMessage;

		const rawAutoPullOnStartup = await settingsGet("autoPullOnStartup");
		const autoPullOnStartup: boolean =
			typeof rawAutoPullOnStartup === "boolean" ? rawAutoPullOnStartup : DEFAULTS.autoPullOnStartup;

		const rawScratchpadVolatile = await settingsGet("scratchpadVolatile");
		const scratchpadVolatile: boolean =
			typeof rawScratchpadVolatile === "boolean"
				? rawScratchpadVolatile
				: DEFAULTS.scratchpadVolatile;

		const rawAutoUpdateCheck = await settingsGet("autoUpdateCheck");
		const autoUpdateCheck: boolean =
			typeof rawAutoUpdateCheck === "boolean" ? rawAutoUpdateCheck : DEFAULTS.autoUpdateCheck;

		const rawFileTreeShowHidden = await settingsGet("fileTreeShowHidden");
		const fileTreeShowHidden: boolean =
			typeof rawFileTreeShowHidden === "boolean"
				? rawFileTreeShowHidden
				: DEFAULTS.fileTreeShowHidden;

		const rawFileTreeExcludePatterns = await settingsGet("fileTreeExcludePatterns");
		const fileTreeExcludePatterns: string =
			typeof rawFileTreeExcludePatterns === "string"
				? rawFileTreeExcludePatterns
				: DEFAULTS.fileTreeExcludePatterns;

		return {
			workspacePath,
			themePreference,
			sidebarVisible,
			showLineNumbers,
			fontSize,
			autoSaveDelay,
			highlightActiveLine,
			fontFamily,
			trimTrailingWhitespace,
			showLinkCards,
			gitSyncEnabled,
			autoCommitInterval,
			autoPullInterval,
			autoPushInterval,
			pullBeforePush,
			syncMethod,
			commitMessage,
			autoPullOnStartup,
			scratchpadVolatile,
			autoUpdateCheck,
			fileTreeShowHidden,
			fileTreeExcludePatterns,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

async function saveSetting(key: string, value: unknown): Promise<void> {
	try {
		await settingsSet(key, value);
		await settingsSave();
	} catch {
		// Ignore save errors — app should continue working
	}
}

// saveWorkspacePath は廃止。workspacePath の永続化は main 側 workspace:set ハンドラが
// 行う（settings:set の reserved key として renderer からの書き込みは拒否される）。
export const saveThemePreference = (preference: ThemePreference) =>
	saveSetting("themePreference", preference);
export const saveSidebarVisible = (visible: boolean) => saveSetting("sidebarVisible", visible);
export const saveShowLineNumbers = (show: boolean) => saveSetting("showLineNumbers", show);
export const saveFontSize = (size: number) => saveSetting("fontSize", size);
export const saveAutoSaveDelay = (delay: number) => saveSetting("autoSaveDelay", delay);
export const saveHighlightActiveLine = (highlight: boolean) =>
	saveSetting("highlightActiveLine", highlight);
export const saveFontFamily = (family: FontFamily) => saveSetting("fontFamily", family);
export const saveTrimTrailingWhitespace = (trim: boolean) =>
	saveSetting("trimTrailingWhitespace", trim);
export const saveShowLinkCards = (show: boolean) => saveSetting("showLinkCards", show);
export const saveGitSyncEnabled = (enabled: boolean) => saveSetting("gitSyncEnabled", enabled);
export const saveAutoCommitInterval = (interval: number) =>
	saveSetting("autoCommitInterval", interval);
export const saveAutoPullInterval = (interval: number) => saveSetting("autoPullInterval", interval);
export const saveAutoPushInterval = (interval: number) => saveSetting("autoPushInterval", interval);
export const savePullBeforePush = (pull: boolean) => saveSetting("pullBeforePush", pull);
export const saveSyncMethod = (method: SyncMethod) => saveSetting("syncMethod", method);
export const saveCommitMessage = (message: string) => saveSetting("commitMessage", message);
export const saveAutoPullOnStartup = (pull: boolean) => saveSetting("autoPullOnStartup", pull);
export const saveScratchpadVolatile = (volatile: boolean) =>
	saveSetting("scratchpadVolatile", volatile);
export const saveAutoUpdateCheck = (enabled: boolean) => saveSetting("autoUpdateCheck", enabled);
export const saveLastUpdateCheck = (timestamp: number) => saveSetting("lastUpdateCheck", timestamp);
export const saveFileTreeShowHidden = (show: boolean) => saveSetting("fileTreeShowHidden", show);
export const saveFileTreeExcludePatterns = (patterns: string) =>
	saveSetting("fileTreeExcludePatterns", patterns);

export async function loadLastUpdateCheck(): Promise<number> {
	try {
		const raw = await settingsGet("lastUpdateCheck");
		return typeof raw === "number" ? raw : 0;
	} catch {
		return 0;
	}
}
