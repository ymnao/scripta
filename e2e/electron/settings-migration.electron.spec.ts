import { readSettings, seedSettings } from "./helpers/fixtures";
import { expect, test } from "./helpers/launch";

// 領域8: Settings migration（旧 Tauri 版互換）。
// store-migration.ts の MIGRATIONS[0] (legacy `theme` → `themePreference` + _schemaVersion=1)
// を実 main 越しに踏む。seed した旧キーが起動時に新キーへ書き換わり、旧キーが
// settings.json から消えること、および _schemaVersion が記録されることをディスクで検証する。
test.describe("settings migration (electron)", () => {
	test("legacy theme=dark が themePreference=dark へ移行され旧キーが削除される", async ({
		launch,
		userDataDir,
	}) => {
		seedSettings(userDataDir, { theme: "dark" });

		const { page } = await launch();

		// themePreference=dark が適用され html に .dark が付く（theme.ts:17）。
		await expect(page.locator("html")).toHaveClass(/dark/);

		// settings.json が書き換わるのを待つ（migration は settingsSave で atomic write）。
		await expect
			.poll(() => readSettings(userDataDir)?.themePreference, { timeout: 5000 })
			.toBe("dark");

		const migrated = readSettings(userDataDir);
		// 旧キーは削除されている。
		expect(migrated).not.toHaveProperty("theme");
		// _schemaVersion が最新版で記録されている (現状は 1)。
		expect(migrated?._schemaVersion).toBe(1);
	});

	test("legacy theme が無い fresh 起動でも themePreference=system が確定し _schemaVersion が刻まれる", async ({
		launch,
		userDataDir,
	}) => {
		// settings.json 無し（初回起動相当）。
		const { page } = await launch();

		// 既定 system テーマ。host が light 想定なので .dark は付かない。
		await expect(page.getByLabel("フォルダを開く")).toBeVisible();

		await expect
			.poll(() => readSettings(userDataDir)?.themePreference, { timeout: 5000 })
			.toBe("system");

		// fresh install でも _schemaVersion は最新で記録される（次回起動以降 migration skip 経路へ）。
		await expect.poll(() => readSettings(userDataDir)?._schemaVersion, { timeout: 5000 }).toBe(1);
	});

	test("_schemaVersion が最新なら legacy theme が残っていても migration をスキップ", async ({
		launch,
		userDataDir,
	}) => {
		// 旧キー theme=dark を残しつつ _schemaVersion=1 を seed。
		// 「過去のセッションで _schemaVersion=1 まで上げたが、何らかの事情で theme key が残っている」
		// ケースを想定。migration は skip され、新しい themePreference=light がそのまま採用される。
		seedSettings(userDataDir, {
			_schemaVersion: 1,
			theme: "dark",
			themePreference: "light",
		});

		const { page } = await launch();

		// themePreference=light → .dark クラスは付かない。
		await expect(page.getByLabel("フォルダを開く")).toBeVisible();
		await expect(page.locator("html")).not.toHaveClass(/dark/);

		// migration スキップなので theme キーは settingsDelete 経由では消えない。
		// 起動中に他の経路 (windowState persist 等) で settings.json が書き戻されても
		// cache 内に残っている theme=dark が write back されるはず。
		await expect
			.poll(() => readSettings(userDataDir)?.themePreference, { timeout: 5000 })
			.toBe("light");
		expect(readSettings(userDataDir)?._schemaVersion).toBe(1);
		expect(readSettings(userDataDir)?.theme).toBe("dark");
	});
});
