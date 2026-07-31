import { TOAST_AUTO_DISMISS_MS, useToastStore } from "../stores/toast";
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
import { translateError } from "./errors";
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
	loadRemoteImages: boolean;
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
	// 既定は true（従来の挙動を維持）。OFF にしたユーザーだけリモート画像が止まる。
	loadRemoteImages: true,
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
	loadRemoteImages: asBoolean,
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

// 起動時 load 経路の失敗通知。startup に 1 回しか走らない経路なのでスロットル窓は持たず、
// saveSetting 側の窓 (notifySaveFailure) にも相乗りさせない。共有すると起動直後の通知が
// 続くユーザー操作起因の save 失敗通知を黙らせ、#446 で可視化した巻き戻りが再び
// 無通知になる（窓を種別ごとに独立させたのと同じ理由）。
function notifyLoadFailure(message: string): void {
	useToastStore.getState().addToast("error", message);
}

// 失敗の粒度を 3 段に分ける。以前は全体を 1 つの try/catch で包んでいたため、migration の
// disk 書き込みが失敗しただけで **settings.json は読めているのにセッション全体が全設定
// 既定値** になっていた（#448）。loadRemoteImages も既定 (true = リモート画像許可) へ
// 戻るが通知は無く、ユーザーには気付けない。
export async function loadSettings(): Promise<AppSettings> {
	// 1) 旧 → 新 schema の段階的変換。store-migration.ts の MIGRATIONS に entry を
	//    追加するだけで新規 migration を組み込める。
	//    失敗しても読み出しへ進む: 未移行のまま残った key は PARSERS が invalid 判定して
	//    その key だけ既定値になるため、読めている他の key まで倒す理由がない。
	let migrated = false;
	try {
		migrated = await applyMigrations({
			get: settingsGet,
			set: settingsSet,
			delete: settingsDelete,
		});
	} catch (err) {
		notifyLoadFailure(
			`設定の移行に失敗しました。旧形式のまま残った設定は既定値で読み込まれます: ${translateError(err)}`,
		);
	}

	// 2) migration 結果の disk 永続化。何か適用された時のみ kick する。
	//    ここだけが失敗した場合、migration の settings:set は成功しているので main 側
	//    cache は移行後の値を持ち **今回の起動中は移行結果が有効**。以降の復旧経路は 2 つ
	//    あり、どちらに転んでも移行結果は失われない:
	//      - 後続の persist が 1 回でも成功すれば cache 全体（_schemaVersion 含む）が
	//        disk に載る。settings:save だけでなく window state の保存 (resize/move の
	//        debounce) も同じ cache を書き出すので、これは十分起こりやすい
	//      - 一度も成功しなければ _schemaVersion も disk に無いままなので、次回起動で
	//        migration が再実行される
	//    したがって「次回起動時に再試行します」は全ケースで真にならない（前者では
	//    再実行されない）。saveSetting の「元の値へ戻ります」もこの経路では成立しない。
	//    文言は両ケースで真な「今回の起動では有効・移行結果は失われない」に絞る。
	if (migrated) {
		try {
			await settingsSave();
		} catch (err) {
			notifyLoadFailure(
				`設定の移行結果を今はファイルに保存できませんでした。移行結果は今回の起動では有効で、失われることはありません: ${translateError(err)}`,
			);
		}
	}

	// 3) 読み出し本体。ここが失敗するのは settings IPC 自体が機能していない状況なので
	//    従来どおり全既定値へ倒すが、無通知にはしない。既定値を disk へ書き戻すことは
	//    しないので、ユーザーの設定値がこの経路で上書きされることはない（同じ起動内で
	//    段 2 の migration 保存が成功していれば settings.json 自体は既に更新済みなので、
	//    「ファイルは無変更」とまでは言えない）。
	try {
		const result = {} as AppSettings;
		for (const key of Object.keys(PARSERS) as (keyof AppSettings)[]) {
			await loadOne(result, key);
		}
		return result;
	} catch (err) {
		notifyLoadFailure(
			`設定を読み込めませんでした。今回は既定値で起動します（既定値をファイルへ書き戻すことはありません）: ${translateError(err)}`,
		);
		return { ...DEFAULTS };
	}
}

// 特定 key の永続化 (save-side)。以前は 22 個の save* wrapper (saveFontSize / saveCommitMessage
// 等) が全て `saveSetting("literal-key", value)` を呼ぶだけの薄膜だったため、まとめて撤去し
// saveSetting を単一 SOT にした。settings store / git-sync store は createPersistedSetter に
// これを渡し、その他 caller (theme / AppLayout / useUpdateCheck) は直接呼ぶ。
// workspacePath の永続化だけは main 側 workspace:set ハンドラが担う (renderer からの
// settings:set は reserved key として拒否される)。
//
// 恒常的な disk 障害下で設定変更が連続した場合 (slide separator のキーリピートは
// 1 打鍵 1 save) に同じ toast が積み上がるのを防ぐ。窓は toast の自動消滅時間に
// 揃えるので、定数は stores/toast.ts のものを直接使う。
//
// 窓は **失敗の種別ごとに独立**に持つ。単一の窓にすると set 失敗の通知が直後の
// save 失敗の通知を黙らせ (逆順も同様)、#446 で可視化したかった巻き戻りが片方の
// 経路で無通知に戻る。
type SaveFailureKind = "set" | "save";

const lastSaveFailureToastAt: Record<SaveFailureKind, number> = { set: 0, save: 0 };

function notifySaveFailure(kind: SaveFailureKind, message: string): void {
	const now = Date.now();
	if (now - lastSaveFailureToastAt[kind] < TOAST_AUTO_DISMISS_MS) return;
	lastSaveFailureToastAt[kind] = now;
	useToastStore.getState().addToast("error", message);
}

// 失敗は caller へ伝播させず（caller は戻り値を見ない前提で書かれており、await を
// catch なしで呼ぶ caller もあるため throw 化は即座に壊す）toast で通知する。#446 の
// 核心は「settings:set は成功したが settings:save だけ失敗した」ケースで、main 側 cache は
// settings:set 時点で更新済みのため **UI もそのセッションの挙動も新しい値・disk だけ旧値**
// が成立する。プライバシー設定 (loadRemoteImages) では「OFF にしたはずが次回起動で ON」
// という気付けない露出になるので、この 2 つの失敗は文言を分けて区別する。
//
// main 側 cache の巻き戻しは行わない: persist() は cache 全体を書き出すため、後続の設定
// 変更が 1 回でも成功すれば失敗した値も一緒に disk へ乗って自然治癒する。巻き戻すと
// 「UI は新値・cache は旧値」の逆向き不整合ができ、次の成功 save が UI と異なる値を
// 永続化してしまう。
export async function saveSetting(key: string, value: unknown): Promise<void> {
	try {
		await settingsSet(key, value);
	} catch (err) {
		// 値が main へ渡っていないケース。renderer 側の設定 (fontSize / theme 等) は
		// caller が save の完了を待たず適用済みなので画面上は効いて見えるが、main が
		// 強制する設定 (loadRemoteImages の CSP / webRequest、fileTree フィルタ) は
		// 今回の起動中も効かない。全 key に共通して言えるのは disk に載らないこと =
		// 次回起動で戻ることなので、文言はそこを伝える。
		notifySaveFailure(
			"set",
			`設定を保存できませんでした。次回起動時に元の値へ戻ります: ${translateError(err)}`,
		);
		return;
	}
	try {
		await settingsSave();
	} catch (err) {
		notifySaveFailure(
			"save",
			`設定をファイルに保存できませんでした。次回起動時に元の値へ戻ります: ${translateError(err)}`,
		);
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
