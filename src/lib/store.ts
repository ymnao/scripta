import { DEFAULT_FILE_TREE_EXCLUDE_PATTERNS } from "../types/file-tree";
import type { SyncMethod } from "../types/git-sync";
import { GIT_SYNC_DEFAULTS, normalizeCommitMessage } from "../types/git-sync";
import {
	SLIDE_PREVIEW_WIDTH_RATIO_DEFAULT,
	SLIDE_PREVIEW_WIDTH_RATIO_MAX,
	SLIDE_PREVIEW_WIDTH_RATIO_MIN,
	SLIDE_THUMBNAILS_VISIBLE_DEFAULT,
} from "../types/slide";
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
	slidePreviewWidthRatio: number;
	slideThumbnailsVisible: boolean;
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
	slidePreviewWidthRatio: SLIDE_PREVIEW_WIDTH_RATIO_DEFAULT,
	slideThumbnailsVisible: SLIDE_THUMBNAILS_VISIBLE_DEFAULT,
};

// 各 key ごとの検証器。invalid なら undefined を返し、呼び出し側で ?? DEFAULTS[key]。
// 新規 setting 追加時は AppSettings / DEFAULTS / PARSERS の 3 箇所のみ触る。
type Parser<T> = (raw: unknown) => T | undefined;

const asBoolean: Parser<boolean> = (raw) => (typeof raw === "boolean" ? raw : undefined);

const asString: Parser<string> = (raw) => (typeof raw === "string" ? raw : undefined);

const asNumberInRange =
	(min: number, max: number): Parser<number> =>
	(raw) =>
		typeof raw === "number" && raw >= min && raw <= max ? raw : undefined;

const asFiniteInRange =
	(min: number, max: number): Parser<number> =>
	(raw) =>
		typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? raw : undefined;

const asLiteralUnion =
	<T extends string>(values: readonly T[]): Parser<T> =>
	(raw) =>
		(values as readonly unknown[]).includes(raw) ? (raw as T) : undefined;

const PARSERS: { [K in keyof AppSettings]: Parser<AppSettings[K]> } = {
	workspacePath: asString,
	themePreference: asLiteralUnion(["system", "light", "dark"] as const),
	sidebarVisible: asBoolean,
	showLineNumbers: asBoolean,
	fontSize: asNumberInRange(8, 32),
	autoSaveDelay: asNumberInRange(500, 10000),
	highlightActiveLine: asBoolean,
	fontFamily: asLiteralUnion(["monospace", "sans-serif", "serif"] as const),
	trimTrailingWhitespace: asBoolean,
	showLinkCards: asBoolean,
	gitSyncEnabled: asBoolean,
	autoCommitInterval: asNumberInRange(0, 1440),
	autoPullInterval: asNumberInRange(0, 1440),
	autoPushInterval: asNumberInRange(0, 1440),
	pullBeforePush: asBoolean,
	syncMethod: asLiteralUnion(["merge", "rebase"] as const),
	// normalizeCommitMessage は必ず string を返すので ?? DEFAULTS は no-op になる。
	commitMessage: normalizeCommitMessage,
	autoPullOnStartup: asBoolean,
	scratchpadVolatile: asBoolean,
	autoUpdateCheck: asBoolean,
	fileTreeShowHidden: asBoolean,
	fileTreeExcludePatterns: asString,
	slidePreviewWidthRatio: asFiniteInRange(
		SLIDE_PREVIEW_WIDTH_RATIO_MIN,
		SLIDE_PREVIEW_WIDTH_RATIO_MAX,
	),
	slideThumbnailsVisible: asBoolean,
};

async function loadOne<K extends keyof AppSettings>(result: AppSettings, key: K): Promise<void> {
	const raw = await settingsGet(key);
	result[key] = PARSERS[key](raw) ?? DEFAULTS[key];
}

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

		const result = {} as AppSettings;
		for (const key of Object.keys(PARSERS) as (keyof AppSettings)[]) {
			await loadOne(result, key);
		}
		return result;
	} catch {
		return { ...DEFAULTS };
	}
}

// 特定 key の永続化 (save-side)。以前は 22 個の save* wrapper (saveFontSize / saveCommitMessage
// 等) が全て `saveSetting("literal-key", value)` を呼ぶだけの薄膜だったため、まとめて撤去し
// saveSetting を単一 SOT にした。settings store / git-sync store は createPersistedSetter に
// これを渡し、その他 caller (theme / AppLayout / useUpdateCheck) は直接呼ぶ。
// workspacePath の永続化だけは main 側 workspace:set ハンドラが担う (renderer からの
// settings:set は reserved key として拒否される)。
export async function saveSetting(key: string, value: unknown): Promise<void> {
	try {
		await settingsSet(key, value);
		await settingsSave();
	} catch {
		// Ignore save errors — app should continue working
	}
}

export async function loadLastUpdateCheck(): Promise<number> {
	try {
		const raw = await settingsGet("lastUpdateCheck");
		return typeof raw === "number" ? raw : 0;
	} catch {
		return 0;
	}
}
