import { load, type Store } from "@tauri-apps/plugin-store";
import type { SyncMethod } from "../types/git-sync";
import { GIT_SYNC_DEFAULTS } from "../types/git-sync";

export type ThemePreference = "system" | "light" | "dark";
export type FontFamily = "monospace" | "sans-serif" | "serif";
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
};

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
	if (!storePromise) {
		storePromise = load("settings.json", { defaults: {}, autoSave: false }).catch((error) => {
			storePromise = null;
			throw error;
		});
	}
	return storePromise;
}

export async function loadSettings(): Promise<AppSettings> {
	try {
		const store = await getStore();
		const workspacePath =
			(await store.get<string | null>("workspacePath")) ?? DEFAULTS.workspacePath;

		// Migration: convert legacy "theme" key to "themePreference"
		let themePreference: ThemePreference = DEFAULTS.themePreference;
		const rawThemePreference = await store.get<unknown>("themePreference");
		if (
			rawThemePreference === "system" ||
			rawThemePreference === "light" ||
			rawThemePreference === "dark"
		) {
			themePreference = rawThemePreference;
		} else {
			// Migrate from legacy "theme" key
			const rawTheme = await store.get<unknown>("theme");
			if (rawTheme === "light" || rawTheme === "dark") {
				themePreference = rawTheme;
			}
			// Persist migrated value and remove legacy key
			await store.set("themePreference", themePreference);
			await store.delete("theme");
			await store.save();
		}

		const rawSidebarVisible = await store.get<unknown>("sidebarVisible");
		const sidebarVisible: boolean =
			typeof rawSidebarVisible === "boolean" ? rawSidebarVisible : DEFAULTS.sidebarVisible;

		const rawShowLineNumbers = await store.get<unknown>("showLineNumbers");
		const showLineNumbers: boolean =
			typeof rawShowLineNumbers === "boolean" ? rawShowLineNumbers : DEFAULTS.showLineNumbers;

		const rawFontSize = await store.get<unknown>("fontSize");
		const fontSize: number =
			typeof rawFontSize === "number" && rawFontSize >= 8 && rawFontSize <= 32
				? rawFontSize
				: DEFAULTS.fontSize;

		const rawAutoSaveDelay = await store.get<unknown>("autoSaveDelay");
		const autoSaveDelay: number =
			typeof rawAutoSaveDelay === "number" && rawAutoSaveDelay >= 500 && rawAutoSaveDelay <= 10000
				? rawAutoSaveDelay
				: DEFAULTS.autoSaveDelay;

		const rawHighlightActiveLine = await store.get<unknown>("highlightActiveLine");
		const highlightActiveLine: boolean =
			typeof rawHighlightActiveLine === "boolean"
				? rawHighlightActiveLine
				: DEFAULTS.highlightActiveLine;

		const rawFontFamily = await store.get<unknown>("fontFamily");
		const fontFamily: FontFamily =
			rawFontFamily === "monospace" || rawFontFamily === "sans-serif" || rawFontFamily === "serif"
				? rawFontFamily
				: DEFAULTS.fontFamily;

		const rawTrimTrailingWhitespace = await store.get<unknown>("trimTrailingWhitespace");
		const trimTrailingWhitespace: boolean =
			typeof rawTrimTrailingWhitespace === "boolean"
				? rawTrimTrailingWhitespace
				: DEFAULTS.trimTrailingWhitespace;

		const rawShowLinkCards = await store.get<unknown>("showLinkCards");
		const showLinkCards: boolean =
			typeof rawShowLinkCards === "boolean" ? rawShowLinkCards : DEFAULTS.showLinkCards;

		const rawGitSyncEnabled = await store.get<unknown>("gitSyncEnabled");
		const gitSyncEnabled: boolean =
			typeof rawGitSyncEnabled === "boolean" ? rawGitSyncEnabled : DEFAULTS.gitSyncEnabled;

		const rawAutoCommitInterval = await store.get<unknown>("autoCommitInterval");
		const autoCommitInterval: number =
			typeof rawAutoCommitInterval === "number" &&
			rawAutoCommitInterval >= 0 &&
			rawAutoCommitInterval <= 1440
				? rawAutoCommitInterval
				: DEFAULTS.autoCommitInterval;

		const rawAutoPullInterval = await store.get<unknown>("autoPullInterval");
		const autoPullInterval: number =
			typeof rawAutoPullInterval === "number" &&
			rawAutoPullInterval >= 0 &&
			rawAutoPullInterval <= 1440
				? rawAutoPullInterval
				: DEFAULTS.autoPullInterval;

		const rawAutoPushInterval = await store.get<unknown>("autoPushInterval");
		const autoPushInterval: number =
			typeof rawAutoPushInterval === "number" &&
			rawAutoPushInterval >= 0 &&
			rawAutoPushInterval <= 1440
				? rawAutoPushInterval
				: DEFAULTS.autoPushInterval;

		const rawPullBeforePush = await store.get<unknown>("pullBeforePush");
		const pullBeforePush: boolean =
			typeof rawPullBeforePush === "boolean" ? rawPullBeforePush : DEFAULTS.pullBeforePush;

		const rawSyncMethod = await store.get<unknown>("syncMethod");
		const syncMethod: SyncMethod =
			rawSyncMethod === "merge" || rawSyncMethod === "rebase" ? rawSyncMethod : DEFAULTS.syncMethod;

		const rawCommitMessage = await store.get<unknown>("commitMessage");
		const trimmedCommitMessage =
			typeof rawCommitMessage === "string" ? rawCommitMessage.trim() : "";
		const commitMessage: string =
			trimmedCommitMessage.length > 0 ? trimmedCommitMessage : DEFAULTS.commitMessage;

		const rawAutoPullOnStartup = await store.get<unknown>("autoPullOnStartup");
		const autoPullOnStartup: boolean =
			typeof rawAutoPullOnStartup === "boolean" ? rawAutoPullOnStartup : DEFAULTS.autoPullOnStartup;

		const rawScratchpadVolatile = await store.get<unknown>("scratchpadVolatile");
		const scratchpadVolatile: boolean =
			typeof rawScratchpadVolatile === "boolean"
				? rawScratchpadVolatile
				: DEFAULTS.scratchpadVolatile;

		const rawAutoUpdateCheck = await store.get<unknown>("autoUpdateCheck");
		const autoUpdateCheck: boolean =
			typeof rawAutoUpdateCheck === "boolean" ? rawAutoUpdateCheck : DEFAULTS.autoUpdateCheck;

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
		};
	} catch {
		return { ...DEFAULTS };
	}
}

async function saveSetting(key: string, value: unknown): Promise<void> {
	try {
		const store = await getStore();
		await store.set(key, value);
		await store.save();
	} catch {
		// Ignore save errors — app should continue working
	}
}

export const saveWorkspacePath = (path: string | null) => saveSetting("workspacePath", path);
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

export async function loadLastUpdateCheck(): Promise<number> {
	try {
		const store = await getStore();
		const raw = await store.get<unknown>("lastUpdateCheck");
		return typeof raw === "number" ? raw : 0;
	} catch {
		return 0;
	}
}
