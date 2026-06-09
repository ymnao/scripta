import { readSettings, seedSettings, writeWorkspaceFiles } from "./helpers/fixtures";
import { expect, modKey, test } from "./helpers/launch";

// 領域4: 設定永続化（実 main + 実 userData）。
// mock では `settingsGet` の返り値を差し替えるだけで、実 main の settings.json
// 読み書き・atomic write・再起動跨ぎの復元は踏めない。ここでは実 IPC 越しに
// 「seed → 復元」「UI 操作 → ディスク永続化 → 再起動復元」の両経路を safety net 化する。
test.describe("settings persistence (electron)", () => {
	test("seed した workspacePath / sidebarVisible が起動時に復元される", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		writeWorkspaceFiles(workspaceDir, { "test.md": "# Hello" });
		seedSettings(userDataDir, { workspacePath: workspaceDir, sidebarVisible: false });

		const { page } = await launch();

		// workspace 復元成功（hasWorkspace=true でのみ描画される検索ボタン）。
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();
		// sidebar 非表示 → ファイルツリー（test.md）も sidebar 内 Open folder も出ない。
		await expect(page.getByLabel("test.md file")).not.toBeVisible();
		await expect(page.getByLabel("フォルダを開く")).not.toBeVisible();
	});

	test("UI で sidebar を閉じるとディスクに永続化され、再起動後も復元される", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		writeWorkspaceFiles(workspaceDir, { "test.md": "# Hello" });
		seedSettings(userDataDir, { workspacePath: workspaceDir, sidebarVisible: true });

		// 1 回目: sidebar 表示状態で起動 → Cmd/Ctrl+/ で閉じる。
		const first = await launch();
		await expect(first.page.getByLabel("test.md file")).toBeVisible();
		await first.page.keyboard.press(`${modKey}+/`);
		await expect(first.page.getByLabel("test.md file")).not.toBeVisible();

		// store が settingsSet+settingsSave で settings.json を atomic write する。
		// 非同期書込なので close 前にディスク反映を待つ（即 close すると未 flush）。
		await expect
			.poll(() => readSettings(userDataDir)?.sidebarVisible, { timeout: 5000 })
			.toBe(false);

		await first.app.close();

		// 2 回目: 同じ userData で再起動 → sidebar=false が復元される。
		const second = await launch(userDataDir);
		await expect(second.page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();
		await expect(second.page.getByLabel("test.md file")).not.toBeVisible();
	});
});
