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

const { createStore, load, persist, getValue, setValue, deleteValue, RESERVED_KEYS } = __testing;

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
