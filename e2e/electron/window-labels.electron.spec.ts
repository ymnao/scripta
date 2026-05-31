import { seedSettings, writeWorkspaceFiles } from "./helpers/fixtures";
import { expect, test } from "./helpers/launch";

// 領域7: Window labels（conflict-resolver の単一インスタンス管理）。
// 旧 Tauri 版 `WebviewWindow.getByLabel("conflict-resolver")` 互換の挙動を
// 実マルチウィンドウで踏む（electron/main/ipc/window.ts）。mock では別 BrowserWindow
// 生成・単一インスタンス・path-guard 委譲を検出できない。
test.describe("window labels / conflict-resolver (electron)", () => {
	test("同じ workspace で再オープンしても conflict window は 1 つ（単一インスタンス）", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		writeWorkspaceFiles(workspaceDir, { "test.md": "# Hello" });
		seedSettings(userDataDir, { workspacePath: workspaceDir });

		const { app, page } = await launch();
		// workspace 復元完了 = main window が workspaceSet で path を register 済み
		// （これがないと openConflictWindow の path-guard が通らない）。
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();
		expect(app.windows().length).toBe(1);

		// 1 回目: conflict window が開く。
		await page.evaluate((ws) => window.api.openConflictWindow(ws), workspaceDir);
		await expect.poll(() => app.windows().length, { timeout: 5000 }).toBe(2);

		// 2 回目: 同じ workspace で再オープン → 既存を focus するだけで増えない。
		await page.evaluate((ws) => window.api.openConflictWindow(ws), workspaceDir);
		// 「増えない」ことの検証なので、新規 window 生成が起きないことを一定時間観察する。
		await expect(async () => {
			await page.waitForTimeout(300);
			expect(app.windows().length).toBe(2);
		}).toPass({ timeout: 3000 });
	});
});
