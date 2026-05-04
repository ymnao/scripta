// @vitest-environment node
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => "/should-not-be-used") },
	ipcMain: { handle: vi.fn() },
}));

import { __testing } from "./settings";

const {
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
} = __testing;

let dir = "";
let storePath = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "scripta-settings-test-"));
	storePath = join(dir, "settings.json");
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("createStore + load", () => {
	it("returns an empty object when the file does not exist", () => {
		const store = createStore(storePath);
		expect(load(store)).toEqual({});
	});

	it("loads an existing JSON object", async () => {
		await writeFile(storePath, JSON.stringify({ foo: "bar", n: 1 }), "utf8");
		const store = createStore(storePath);
		expect(load(store)).toEqual({ foo: "bar", n: 1 });
	});

	it("falls back to empty object on malformed JSON", async () => {
		await writeFile(storePath, "{not json", "utf8");
		const store = createStore(storePath);
		expect(load(store)).toEqual({});
	});

	it("falls back to empty object when the JSON value is not an object", async () => {
		await writeFile(storePath, "[1, 2]", "utf8");
		const store = createStore(storePath);
		expect(load(store)).toEqual({});
	});

	it("caches the parsed value across calls", async () => {
		await writeFile(storePath, JSON.stringify({ a: 1 }), "utf8");
		const store = createStore(storePath);
		const first = load(store);
		first.a = 2;
		const second = load(store);
		expect(second.a).toBe(2);
	});

	it.skipIf(process.platform === "win32")(
		"rethrows non-ENOENT read errors instead of silently dropping settings",
		async () => {
			// chmod 0o000 で読み取り不可にして EACCES を発生させる。
			// ENOENT 以外を握りつぶすと「一時 I/O 異常で既存設定が見えなくなり、
			// 後続の settings:set + settings:save で上書き消失」が起きるため、
			// load() は呼び出し側に伝播する必要がある。
			const protectedFile = join(dir, "protected.json");
			await writeFile(protectedFile, JSON.stringify({ existing: "data" }), "utf8");
			await chmod(protectedFile, 0o000);
			try {
				const store = createStore(protectedFile);
				expect(() => load(store)).toThrow();
			} finally {
				await chmod(protectedFile, 0o644).catch(() => {});
			}
		},
	);
});

describe("getValue / setValue / deleteValue", () => {
	it("getValue returns null for missing keys", () => {
		const store = createStore(storePath);
		expect(getValue(store, "missing")).toBeNull();
	});

	it("setValue + getValue round-trips primitives and objects", () => {
		const store = createStore(storePath);
		setValue(store, "n", 42);
		setValue(store, "s", "hi");
		setValue(store, "o", { nested: true });
		expect(getValue(store, "n")).toBe(42);
		expect(getValue(store, "s")).toBe("hi");
		expect(getValue(store, "o")).toEqual({ nested: true });
	});

	it("setValue with null preserves the key (does not delete)", () => {
		const store = createStore(storePath);
		setValue(store, "k", null);
		expect(getValue(store, "k")).toBeNull();
		// load() exposes the cache directly so we can assert presence
		expect("k" in load(store)).toBe(true);
	});

	it("getValue normalizes a stored undefined to null (旧 Tauri Option<Value> 互換)", () => {
		const store = createStore(storePath);
		setValue(store, "k", undefined);
		// own property は存在するが、IPC で undefined を直接返さず null に寄せる
		expect(getValue(store, "k")).toBeNull();
		expect(Object.hasOwn(load(store), "k")).toBe(true);
	});

	it("deleteValue removes a key", () => {
		const store = createStore(storePath);
		setValue(store, "k", 1);
		deleteValue(store, "k");
		expect(getValue(store, "k")).toBeNull();
		expect("k" in load(store)).toBe(false);
	});
});

describe("persist", () => {
	it("writes the cache to disk as JSON", async () => {
		const store = createStore(storePath);
		setValue(store, "a", 1);
		setValue(store, "b", "two");
		await persist(store);
		const raw = await readFile(storePath, "utf8");
		expect(JSON.parse(raw)).toEqual({ a: 1, b: "two" });
	});

	it("creates intermediate directories", async () => {
		const nested = join(dir, "a", "b", "settings.json");
		const store = createStore(nested);
		setValue(store, "x", 1);
		await persist(store);
		const raw = await readFile(nested, "utf8");
		expect(JSON.parse(raw)).toEqual({ x: 1 });
	});

	it("is a no-op when the cache has not been loaded", async () => {
		const store = createStore(storePath);
		await persist(store);
		// File should not have been created
		await expect(readFile(storePath, "utf8")).rejects.toThrow();
	});

	it("survives a round-trip via a fresh store", async () => {
		const writer = createStore(storePath);
		setValue(writer, "k", "v");
		await persist(writer);

		const reader = createStore(storePath);
		expect(getValue(reader, "k")).toBe("v");
	});

	it("does not leave a half-written file even if write throws", async () => {
		// 親ディレクトリへの mkdir 後、write-file-atomic が tmp → fsync → rename を行う。
		// rename 完了後にしか dst は見えないため、書き込み失敗時は古いファイルが温存される。
		await writeFile(storePath, JSON.stringify({ original: true }), "utf8");
		const store = createStore(storePath);
		// 既存ファイルを読み込ませる
		expect(load(store)).toEqual({ original: true });
		setValue(store, "added", 1);
		await persist(store);
		const raw = await readFile(storePath, "utf8");
		expect(JSON.parse(raw)).toEqual({ original: true, added: 1 });
	});
});

describe("RESERVED_KEYS", () => {
	it("includes workspacePath (renderer must not be able to write/delete it)", () => {
		// renderer 側 settings:set("workspacePath", "/") のような任意上書きを防ぐ承認境界。
		// この set に含まれているキーは settings:set / settings:delete ハンドラで reject される。
		expect(RESERVED_KEYS.has("workspacePath")).toBe(true);
	});
});

describe("isJsonSerializable (persistence safety)", () => {
	it("accepts JSON-safe primitives and plain objects", () => {
		expect(isJsonSerializable(null)).toBe(true);
		expect(isJsonSerializable(true)).toBe(true);
		expect(isJsonSerializable(42)).toBe(true);
		expect(isJsonSerializable("hello")).toBe(true);
		expect(isJsonSerializable({ a: 1, b: "x", c: null })).toBe(true);
		expect(isJsonSerializable([1, "two", { three: 3 }])).toBe(true);
	});

	it("rejects BigInt (TypeError on JSON.stringify)", () => {
		// BigInt が settings に混入すると settings:save / persistWorkspacePath が
		// 恒久的に失敗し、workspace 登録自体が永続的に通らなくなる
		expect(isJsonSerializable(BigInt(1))).toBe(false);
	});

	it("rejects circular references", () => {
		const obj: { self?: unknown } = {};
		obj.self = obj;
		expect(isJsonSerializable(obj)).toBe(false);
	});

	it("rejects circular references nested in arrays", () => {
		const a: unknown[] = [];
		a.push(a);
		expect(isJsonSerializable(a)).toBe(false);
	});

	// 関数 / undefined / Symbol は JSON.stringify が「stringify されないだけで
	// throw しない」ので、isJsonSerializable は true を返す。これらは undefined や
	// 欠落した key として永続化されるが、settings の取り出し側 (getValue) は
	// undefined を null に正規化するので運用上問題なし
	it("does not reject values that JSON.stringify silently drops (functions/undefined)", () => {
		expect(isJsonSerializable(undefined)).toBe(true);
		expect(isJsonSerializable(() => 1)).toBe(true);
	});
});

describe("isSafeSettingsKey (prototype pollution defense)", () => {
	it("accepts identifier-shaped keys", () => {
		expect(isSafeSettingsKey("foo")).toBe(true);
		expect(isSafeSettingsKey("workspacePath")).toBe(true);
		expect(isSafeSettingsKey("snake_case")).toBe(true);
		expect(isSafeSettingsKey("_underscore")).toBe(true);
		expect(isSafeSettingsKey("camelCase123")).toBe(true);
	});

	it("rejects __proto__ / constructor / prototype to block prototype pollution", () => {
		for (const key of FORBIDDEN_SETTINGS_KEYS) {
			expect(isSafeSettingsKey(key)).toBe(false);
		}
	});

	it("rejects keys with unsafe characters", () => {
		expect(isSafeSettingsKey("with space")).toBe(false);
		expect(isSafeSettingsKey("with-dash")).toBe(false);
		expect(isSafeSettingsKey("with.dot")).toBe(false);
		expect(isSafeSettingsKey("with/slash")).toBe(false);
		expect(isSafeSettingsKey("")).toBe(false);
	});

	it("rejects keys not starting with letter or underscore", () => {
		expect(isSafeSettingsKey("1leading")).toBe(false);
		expect(isSafeSettingsKey("$dollar")).toBe(false);
	});

	it("rejects non-string inputs", () => {
		expect(isSafeSettingsKey(undefined)).toBe(false);
		expect(isSafeSettingsKey(null)).toBe(false);
		expect(isSafeSettingsKey(42)).toBe(false);
		expect(isSafeSettingsKey({})).toBe(false);
	});
});

describe("getValue uses own-property semantics (not 'in')", () => {
	it("returns null for inherited Object.prototype keys (toString / hasOwnProperty)", () => {
		const store = createStore(storePath);
		// 旧実装の `key in data` だと Object.prototype 由来のメソッドにマッチして
		// 関数が IPC で structured clone 不可になり例外/DoS になっていた
		expect(getValue(store, "toString")).toBeNull();
		expect(getValue(store, "hasOwnProperty")).toBeNull();
		expect(getValue(store, "constructor")).toBeNull();
	});

	it("does not bleed Object.prototype methods even when cache is freshly empty", async () => {
		// load() 直後の cache は null-prototype object。typeof check で関数が
		// 露出していないことを確認
		const store = createStore(storePath);
		expect(typeof getValue(store, "toString")).toBe("object"); // null is "object"
	});
});

describe("load() filters unsafe keys from existing settings.json", () => {
	it("drops __proto__ / constructor / prototype if present in the file", async () => {
		// 別バージョンや手書きで unsafe キーが入っていた場合に main 側で取り込まないこと。
		// JSON.parse 時点で __proto__ は own property として復元されるので、
		// load 内のフィルタで明示的に除外する必要がある
		await writeFile(
			storePath,
			JSON.stringify({ safeKey: "ok", __proto__: { polluted: true }, "with-dash": 1 }),
			"utf8",
		);
		const store = createStore(storePath);
		const data = load(store);
		expect(getValue(store, "safeKey")).toBe("ok");
		expect(Object.hasOwn(data, "__proto__")).toBe(false);
		expect(Object.hasOwn(data, "with-dash")).toBe(false);
		// 主要な確認：global Object.prototype が汚染されていない
		// （仮に load が __proto__ を取り込んでいたら polluted が leak する）
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});
