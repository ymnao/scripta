import { describe, expect, it } from "vitest";
import {
	applyMigrations,
	LATEST_SCHEMA_VERSION,
	MIGRATIONS,
	type MigrationContext,
} from "./store-migration";

// in-memory な MigrationContext。実 IPC を経由せず migration ロジック単体を検証する。
// settings.json (cache) の挙動 (own property のみ参照、null 既定) を mimic する。
function createMemoryContext(initial: Record<string, unknown> = {}): {
	ctx: MigrationContext;
	store: Record<string, unknown>;
} {
	const store: Record<string, unknown> = { ...initial };
	const ctx: MigrationContext = {
		get: async (key) => (Object.hasOwn(store, key) ? store[key] : null),
		set: async (key, value) => {
			store[key] = value;
		},
		delete: async (key) => {
			delete store[key];
		},
	};
	return { ctx, store };
}

describe("store-migration", () => {
	describe("MIGRATIONS の構造", () => {
		it("version が昇順で並んでいる", () => {
			for (let i = 1; i < MIGRATIONS.length; i++) {
				expect(MIGRATIONS[i].version).toBeGreaterThan(MIGRATIONS[i - 1].version);
			}
		});

		it("LATEST_SCHEMA_VERSION が末尾 entry の version と一致する", () => {
			if (MIGRATIONS.length === 0) {
				expect(LATEST_SCHEMA_VERSION).toBe(0);
			} else {
				expect(LATEST_SCHEMA_VERSION).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
			}
		});
	});

	describe("applyMigrations", () => {
		it("fresh install (_schemaVersion 無し、legacy key 無し) で最新版まで適用", async () => {
			const { ctx, store } = createMemoryContext();
			const applied = await applyMigrations(ctx);

			expect(applied).toBe(true);
			expect(store._schemaVersion).toBe(LATEST_SCHEMA_VERSION);
		});

		it("legacy theme=dark を themePreference=dark に変換し旧キーを削除", async () => {
			const { ctx, store } = createMemoryContext({ theme: "dark" });
			const applied = await applyMigrations(ctx);

			expect(applied).toBe(true);
			expect(store.themePreference).toBe("dark");
			expect(store).not.toHaveProperty("theme");
			expect(store._schemaVersion).toBe(LATEST_SCHEMA_VERSION);
		});

		it("legacy theme=light を themePreference=light に変換", async () => {
			const { ctx, store } = createMemoryContext({ theme: "light" });
			await applyMigrations(ctx);

			expect(store.themePreference).toBe("light");
			expect(store).not.toHaveProperty("theme");
		});

		it("themePreference が既に設定済みなら新値を上書きしない", async () => {
			const { ctx, store } = createMemoryContext({
				themePreference: "dark",
				theme: "light",
			});
			await applyMigrations(ctx);

			expect(store.themePreference).toBe("dark");
			expect(store).not.toHaveProperty("theme");
			expect(store._schemaVersion).toBe(LATEST_SCHEMA_VERSION);
		});

		it("legacy theme が無効値なら themePreference=system にフォールバック", async () => {
			const { ctx, store } = createMemoryContext({ theme: "invalid-value" });
			await applyMigrations(ctx);

			expect(store.themePreference).toBe("system");
			expect(store).not.toHaveProperty("theme");
		});

		it("_schemaVersion=LATEST なら no-op (applied=false)", async () => {
			const initial = {
				_schemaVersion: LATEST_SCHEMA_VERSION,
				themePreference: "dark",
			};
			const { ctx, store } = createMemoryContext(initial);
			const applied = await applyMigrations(ctx);

			expect(applied).toBe(false);
			// store の content が一切変化していない (set / delete が呼ばれていない proxy)
			expect(store).toEqual(initial);
		});

		it("_schemaVersion が未来版なら no-op (ダウングレード抑止)", async () => {
			const { ctx, store } = createMemoryContext({
				_schemaVersion: LATEST_SCHEMA_VERSION + 99,
				theme: "dark",
			});
			const applied = await applyMigrations(ctx);

			expect(applied).toBe(false);
			expect(store.theme).toBe("dark");
			expect(store).not.toHaveProperty("themePreference");
		});

		it("_schemaVersion が不正な値 (string) なら 0 扱いで全 migration を適用", async () => {
			const { ctx, store } = createMemoryContext({
				_schemaVersion: "not-a-number",
				theme: "dark",
			});
			const applied = await applyMigrations(ctx);

			expect(applied).toBe(true);
			expect(store.themePreference).toBe("dark");
			expect(store._schemaVersion).toBe(LATEST_SCHEMA_VERSION);
		});

		it("_schemaVersion が負値なら 0 扱い", async () => {
			const { ctx } = createMemoryContext({ _schemaVersion: -1 });
			const applied = await applyMigrations(ctx);
			expect(applied).toBe(true);
		});
	});
});
