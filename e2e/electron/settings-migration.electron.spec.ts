import { readSettings, seedSettings } from "./helpers/fixtures";
import { expect, test } from "./helpers/launch";

// 領域8: Settings migration（旧 Tauri 版互換）。
// store.ts:66-85 の legacy `theme` → `themePreference` キー移行を実 main 越しに踏む。
// seed した旧キーが起動時に新キーへ書き換わり、旧キーが settings.json から消える
// ことをディスクで検証する。撤去判断は ADR-0001 候補（HANDOFF / inventory §3）。
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
	});

	test("legacy theme が無い fresh 起動でも themePreference=system が確定する", async ({
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
	});
});
