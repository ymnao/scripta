import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, ipcMain } from "electron";
import writeFileAtomic from "write-file-atomic";
import { isErrnoCode } from "../utils/fs-errors";

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

async function persist(store: Store): Promise<void> {
	if (store.cache === null) return;
	// write-file-atomic は tmp への write → fsync → rename を保証するため、
	// 電源断やクラッシュで settings.json が破損した状態にならない。
	await mkdir(dirname(store.path), { recursive: true });
	await writeFileAtomic(store.path, JSON.stringify(store.cache, null, 2), {
		encoding: "utf8",
	});
}

// undefined と未設定を区別しない（旧 Tauri 版と同じセマンティクス）。
// null を set した key は load() の data に残るが getValue は null を返す。
// own property のみを参照することで Object.prototype 由来 (toString 等) の
// 誤マッチや IPC で関数を返してしまう事故を防ぐ。
function getValue(store: Store, key: string): unknown {
	const data = load(store);
	return Object.hasOwn(data, key) ? data[key] : null;
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
const RESERVED_KEYS: ReadonlySet<string> = new Set(["workspacePath"]);

export async function persistWorkspacePath(path: string | null): Promise<void> {
	const store = getMainStore();
	if (path === null) {
		deleteValue(store, "workspacePath");
	} else {
		setValue(store, "workspacePath", path);
	}
	await persist(store);
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
		setValue(getMainStore(), key, value);
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
		deleteValue(getMainStore(), key);
	});
	ipcMain.handle("settings:save", async () => {
		await persist(getMainStore());
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
	FORBIDDEN_SETTINGS_KEYS,
};
