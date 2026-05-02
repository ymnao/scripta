import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, ipcMain } from "electron";
import writeFileAtomic from "write-file-atomic";

interface Store {
	path: string;
	cache: Record<string, unknown> | null;
}

function createStore(path: string): Store {
	return { path, cache: null };
}

function load(store: Store): Record<string, unknown> {
	if (store.cache !== null) return store.cache;
	if (!existsSync(store.path)) {
		store.cache = {};
		return store.cache;
	}
	try {
		const raw = readFileSync(store.path, "utf8");
		const parsed = JSON.parse(raw);
		store.cache =
			typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
	} catch {
		store.cache = {};
	}
	return store.cache;
}

async function persist(store: Store): Promise<void> {
	if (store.cache === null) return;
	// write-file-atomic は temp file への write → fsync → rename を行う。
	// 電源断やプロセスクラッシュでも、settings.json が空 / 半端な状態に
	// なることを防ぐ（rename だけでは fsync 抜けで OS バッファ未flush の事故が残る）。
	await mkdir(dirname(store.path), { recursive: true });
	await writeFileAtomic(store.path, JSON.stringify(store.cache, null, 2), {
		encoding: "utf8",
	});
}

function getValue(store: Store, key: string): unknown {
	const data = load(store);
	return key in data ? data[key] : null;
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

export function registerSettingsIpc(): void {
	ipcMain.handle(
		"settings:get",
		async (_event, key: string): Promise<unknown> => getValue(getMainStore(), key),
	);
	ipcMain.handle("settings:set", async (_event, key: string, value: unknown) => {
		setValue(getMainStore(), key, value);
	});
	ipcMain.handle("settings:delete", async (_event, key: string) => {
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
};
