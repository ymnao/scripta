import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, ipcMain } from "electron";
import writeFileAtomic from "write-file-atomic";
import { DEFAULT_FILE_TREE_EXCLUDE_PATTERNS, type EntryFilterOptions } from "../utils/entry-filter";
import { isErrnoCode } from "../utils/fs-errors";
import { normalizeWindowState, type WindowState } from "../utils/window-state";

interface Store {
	path: string;
	cache: Record<string, unknown> | null;
}

// 設定キーは識別子相当の文字種に限定する。__proto__ / constructor / prototype を
// 含む危険キーや、想定外の文字を含むキーを設定経路（settings:set / settings:delete）
// で受け付けない。これにより main プロセスの prototype pollution を断つ。
const SAFE_SETTINGS_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FORBIDDEN_SETTINGS_KEYS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

export function isSafeSettingsKey(key: unknown): key is string {
	if (typeof key !== "string") return false;
	if (FORBIDDEN_SETTINGS_KEYS.has(key)) return false;
	return SAFE_SETTINGS_KEY_PATTERN.test(key);
}

// settings 値に求める 2 つの不変条件を入力受付時に検証する：
//   1. JSON.stringify が完走する（永続化が恒久失敗しない。BigInt / 循環参照を排除）
//   2. structuredClone が完走する（settings:get の IPC 戻り値で DataCloneError に
//      ならない。function / Symbol などを排除）
// JSON.stringify は function / Symbol を silently drop するだけで throw しない
// ため、structuredClone と併用しないと侵害された renderer がそれらを cache に
// 入れて settings:get 越しに main を DoS できる。
export function isJsonSerializable(value: unknown): boolean {
	try {
		JSON.stringify(value);
	} catch {
		return false;
	}
	try {
		// structuredClone は Node 17+ で標準。Electron 41 (Node 22 系) で利用可。
		structuredClone(value);
	} catch {
		return false;
	}
	return true;
}

// null-prototype object を返す。get/set/delete 時に Object.prototype 由来の
// メソッド（toString 等）が誤ってマッチするのを防ぎ、prototype pollution の
// 足掛かりにもならない。
function emptyStore(): Record<string, unknown> {
	return Object.create(null) as Record<string, unknown>;
}

function createStore(path: string): Store {
	return { path, cache: null };
}

function load(store: Store): Record<string, unknown> {
	if (store.cache !== null) return store.cache;
	let raw: string;
	try {
		raw = readFileSync(store.path, "utf8");
	} catch (e) {
		// ENOENT は初回起動 → 空オブジェクトにフォールバック
		// EACCES / EIO 等は呼び出し側に伝える（黙って空にすると、その後の
		// settings:set + settings:save で既存設定を上書き消失させる）
		if (isErrnoCode(e, "ENOENT")) {
			store.cache = emptyStore();
			return store.cache;
		}
		throw e;
	}
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			// settings.json が手で壊された / 別バージョンが書いた可能性に備え、
			// 安全なキーだけを null-prototype の cache に取り込む
			const safe = emptyStore();
			for (const [k, v] of Object.entries(parsed)) {
				if (isSafeSettingsKey(k)) safe[k] = v;
			}
			store.cache = safe;
		} else {
			store.cache = emptyStore();
		}
	} catch {
		// JSON 破損はユーザーの誤操作で壊した場合の救済として空にフォールバック
		store.cache = emptyStore();
	}
	return store.cache;
}

// settings.json への書き込みは 1 種類の sync 関数に集約する。async と sync を
// 併用すると次の race が起きる：（A）async 経路（旧 persist）が `await mkdir` の
// 後に JSON.stringify した古い snapshot で writeFileAtomic を kick →（B）別経路
// （windowState 同期保存 / 別の async settings:save）が完了 →（A）の writeFileAtomic
// が遅れて完了して古い内容で上書き、というケース。
//
// settings.json は < 1KB かつ書き込み頻度も低い（renderer 操作 / window resize
// debounce 500ms / workspace 切替）ので、writeFileAtomic.sync が常に <1ms で
// 完了する。sync で event loop を atomic に占有することで、複数経路の書き込み
// が重なっても直列化される。
//
// write-file-atomic は tmp への write → fsync → rename を保証するため、電源断や
// クラッシュで settings.json が破損した状態にならない。
function persist(store: Store): void {
	if (store.cache === null) return;
	mkdirSync(dirname(store.path), { recursive: true });
	writeFileAtomic.sync(store.path, JSON.stringify(store.cache, null, 2), {
		encoding: "utf8",
	});
}

// 「未設定（own property なし）」と「null/undefined を set 済み」をどちらも
// null として返す（未設定と明示的な null を区別しない仕様）。own property のみを参照することで
// Object.prototype 由来 (toString 等) の誤マッチや IPC で関数を返してしまう
// 事故を防ぐ。
function getValue(store: Store, key: string): unknown {
	const data = load(store);
	if (!Object.hasOwn(data, key)) return null;
	const v = data[key];
	return v === undefined ? null : v;
}

function setValue(store: Store, key: string, value: unknown): void {
	const data = load(store);
	data[key] = value;
}

function deleteValue(store: Store, key: string): void {
	const data = load(store);
	delete data[key];
}

let mainStore: Store | null = null;

function getMainStore(): Store {
	if (!mainStore) {
		mainStore = createStore(join(app.getPath("userData"), "settings.json"));
	}
	return mainStore;
}

// 起動時に「前回までの workspacePath」を approve リストに入れるための副作用なし getter。
// load() が EACCES 等で throw した場合は null を返し、approve をスキップする。
// 過去にユーザーが OS ネイティブな folder picker で承認した path なので、
// プロセス再起動後もユーザー承認済み扱いとして再入場を許可する。
export function getWorkspacePathFromSettings(): string | null {
	try {
		const data = load(getMainStore());
		return typeof data.workspacePath === "string" ? data.workspacePath : null;
	} catch {
		return null;
	}
}

// renderer から settings:set / settings:delete を介して書き換えられないキー。
// workspacePath は workspace:set の承認境界（main 側 isWorkspacePathApproved）を
// バイパスされる経路になりうるため main 専用にする。永続化は persistWorkspacePath
// 経由で workspace:set ハンドラ側から行う。
// windowState は BrowserWindow の挙動制御に直接使われる（壊れた bounds で
// setBounds が throw → 初回起動から不可視ウィンドウになる）ので main 専用。
const RESERVED_KEYS: ReadonlySet<string> = new Set(["workspacePath", "windowState"]);

export function persistWorkspacePath(path: string | null): void {
	const store = getMainStore();
	if (path === null) {
		deleteValue(store, "workspacePath");
	} else {
		setValue(store, "workspacePath", path);
	}
	persist(store);
}

export function getWindowState(): WindowState | null {
	try {
		const data = load(getMainStore());
		return normalizeWindowState(data.windowState);
	} catch {
		return null;
	}
}

export function persistWindowState(state: WindowState): void {
	const store = getMainStore();
	setValue(store, "windowState", state);
	persist(store);
}

export function getFileTreeFilterOptions(): EntryFilterOptions {
	try {
		const data = load(getMainStore());
		const showHidden =
			typeof data.fileTreeShowHidden === "boolean" ? data.fileTreeShowHidden : false;
		const excludePatterns =
			typeof data.fileTreeExcludePatterns === "string"
				? data.fileTreeExcludePatterns
				: DEFAULT_FILE_TREE_EXCLUDE_PATTERNS;
		return { showHidden, excludePatterns };
	} catch {
		return {
			showHidden: false,
			excludePatterns: DEFAULT_FILE_TREE_EXCLUDE_PATTERNS,
		};
	}
}

// FileTree フィルタ設定（showHidden / excludePatterns）変更時に発火する。watcher.ts が
// 全 window への `workspace:reload-tree` broadcast を購読する（chokidar の再起動は伴わない —
// watcher は user 設定から切り離されており、設定変更で監視範囲は変わらないため）。
const fileTreeFilterListeners: Set<() => void> = new Set();

export function onFileTreeFilterChange(listener: () => void): () => void {
	fileTreeFilterListeners.add(listener);
	return () => {
		fileTreeFilterListeners.delete(listener);
	};
}

function emitFileTreeFilterChange(): void {
	for (const listener of fileTreeFilterListeners) {
		try {
			listener();
		} catch (error) {
			console.warn("[settings] file-tree filter listener failed:", error);
		}
	}
}

function isFileTreeFilterKey(key: string): boolean {
	return key === "fileTreeShowHidden" || key === "fileTreeExcludePatterns";
}

function readCurrentValue(store: Store, key: string): unknown {
	const data = load(store);
	return Object.hasOwn(data, key) ? data[key] : undefined;
}

export function registerSettingsIpc(): void {
	ipcMain.handle("settings:get", async (_event, key: unknown): Promise<unknown> => {
		// 不正キーは throw せず null。renderer は「未設定」として既定値にフォールバックする
		if (!isSafeSettingsKey(key)) return null;
		return getValue(getMainStore(), key);
	});
	ipcMain.handle("settings:set", async (_event, key: unknown, value: unknown) => {
		if (!isSafeSettingsKey(key)) {
			throw new Error(
				`Invalid settings key: ${typeof key === "string" ? `"${key}"` : "(non-string)"}`,
			);
		}
		if (RESERVED_KEYS.has(key)) {
			throw new Error(`Permission denied: settings key "${key}" is reserved`);
		}
		if (!isJsonSerializable(value)) {
			throw new Error("Invalid settings value: not JSON-serializable");
		}
		const store = getMainStore();
		// FileTree フィルタ変更は全 window に `workspace:reload-tree` を broadcast するため、
		// 値変化のない write は no-op として swallow する（同じ string を渡された場合の
		// 無駄な reload を防ぐ）。filter 対象外のキーは従来どおり set のみ。
		const notifyFilter = isFileTreeFilterKey(key) && readCurrentValue(store, key) !== value;
		setValue(store, key, value);
		if (notifyFilter) emitFileTreeFilterChange();
	});
	ipcMain.handle("settings:delete", async (_event, key: unknown) => {
		if (!isSafeSettingsKey(key)) {
			throw new Error(
				`Invalid settings key: ${typeof key === "string" ? `"${key}"` : "(non-string)"}`,
			);
		}
		if (RESERVED_KEYS.has(key)) {
			throw new Error(`Permission denied: settings key "${key}" is reserved`);
		}
		const store = getMainStore();
		const notifyFilter = isFileTreeFilterKey(key) && readCurrentValue(store, key) !== undefined;
		deleteValue(store, key);
		if (notifyFilter) emitFileTreeFilterChange();
	});
	ipcMain.handle("settings:save", async () => {
		persist(getMainStore());
	});
}

export const __testing = {
	createStore,
	load,
	persist,
	getValue,
	setValue,
	deleteValue,
	RESERVED_KEYS,
	isSafeSettingsKey,
	isJsonSerializable,
	FORBIDDEN_SETTINGS_KEYS,
	emitFileTreeFilterChange,
	resetForTests(): void {
		mainStore = null;
		fileTreeFilterListeners.clear();
	},
};
