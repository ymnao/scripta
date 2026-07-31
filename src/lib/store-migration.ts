// settings.json の schema migration を versioned array で表現する。
// 新しい migration の追加手順は docs/specification.md 「Settings の追加・移行フロー」を参照。
//
// 注意: settings IPC は key-level (settings:get / set / delete / save) であり、
// settings.json 全体を一括取得する API は存在しない。そのため migration は
// `MigrationContext` の get/set/delete を介した副作用として記述する。

export interface MigrationContext {
	get: (key: string) => Promise<unknown>;
	set: (key: string, value: unknown) => Promise<void>;
	delete: (key: string) => Promise<void>;
}

export interface Migration {
	// この migration を適用した後の _schemaVersion。MIGRATIONS は version 昇順で並べる。
	version: number;
	// run は **部分適用済みの状態からの再実行に耐える冪等な実装**にすること。途中で
	// throw すると成功済みの ctx.set は残る一方 _schemaVersion は bump されないため、
	// 次回起動で同じ migration が半分適用済みの状態に対して再実行される (#448 で
	// loadSettings が migration 失敗時も読み出しを継続するようになり、この再実行が
	// 正式な回復経路になった)。v1 の alreadyMigrated ガードがその形。
	run: (ctx: MigrationContext) => Promise<void>;
}

export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		// legacy "theme" key を "themePreference" に変換し旧キーを削除する。
		run: async (ctx) => {
			const rawThemePreference = await ctx.get("themePreference");
			const alreadyMigrated =
				rawThemePreference === "system" ||
				rawThemePreference === "light" ||
				rawThemePreference === "dark";
			if (!alreadyMigrated) {
				const rawTheme = await ctx.get("theme");
				const themePreference: "system" | "light" | "dark" =
					rawTheme === "light" || rawTheme === "dark" ? rawTheme : "system";
				await ctx.set("themePreference", themePreference);
			}
			await ctx.delete("theme");
		},
	},
];

export const LATEST_SCHEMA_VERSION: number =
	MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;

// 戻り値 true の時のみ呼び出し側で settings:save を kick する。
export async function applyMigrations(ctx: MigrationContext): Promise<boolean> {
	const rawVersion = await ctx.get("_schemaVersion");
	const currentVersion =
		typeof rawVersion === "number" && Number.isInteger(rawVersion) && rawVersion >= 0
			? rawVersion
			: 0;

	const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
	if (pending.length === 0) return false;

	for (const m of pending) {
		await m.run(ctx);
	}
	await ctx.set("_schemaVersion", LATEST_SCHEMA_VERSION);
	return true;
}
