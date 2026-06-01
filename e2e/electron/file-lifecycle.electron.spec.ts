import {
	markInitialized,
	readWorkspaceFile,
	seedSettings,
	writeWorkspaceFiles,
} from "./helpers/fixtures";
import { expect, modKey, test } from "./helpers/launch";

// 領域9: ファイルライフサイクル（実 fs CRUD + 再起動跨ぎのディスク永続化）。
// mock では `readFile`/`writeFile` を in-memory map で差し替えるだけで、実 main の
// `fs:read`/`fs:write`（path-guard + `mkdir -p` + 実ディスク書き込み）も、保存パスが
// renderer 側 processContent（末尾改行正規化）を経た実ペイロードをディスクへ書くところも、
// 再起動後にその内容が本当に残っているかも踏めない。ここでは実 IPC 越しに
// 「開く → 編集 → 保存 → ディスク反映 → 再起動 → 再オープンで編集内容が復元」を
// 1 本の往復シナリオとして safety net 化する（issue #86 シナリオ 2 / #33 本体）。
test.describe("file lifecycle (electron)", () => {
	test("ファイルを開いて編集・保存するとディスクへ永続化され、再起動後も内容が復元される", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		writeWorkspaceFiles(workspaceDir, { "hello.md": "# Hello World" });
		// ファイルツリーを click するため SetupWizardDialog を抑止する。
		markInitialized(workspaceDir);
		seedSettings(userDataDir, { workspacePath: workspaceDir, sidebarVisible: true });

		// 1 回目: 開く → 編集 → 保存。
		const first = await launch();
		await first.page.getByLabel("hello.md file").click();
		await expect(first.page.locator(".cm-content")).toContainText("Hello World");

		await first.page.locator(".cm-content").click();
		await first.page.keyboard.type(" updated");
		// 編集直後は「未保存」。
		await expect(first.page.getByText("未保存")).toBeVisible();

		// Cmd/Ctrl+S で autosave debounce を待たず即保存 → 実 main が fs:write。
		await first.page.keyboard.press(`${modKey}+s`);
		await expect(first.page.getByText("保存済み", { exact: true })).toBeVisible({ timeout: 5000 });

		// ディスク上の実体を検証する。renderer 側 processContent（末尾改行保証）適用後の
		// ペイロード。poll で（非同期の）保存 → fs:write の実ディスク反映を待つ。
		await expect
			.poll(() => readWorkspaceFile(workspaceDir, "hello.md"), { timeout: 5000 })
			.toBe("# Hello World updated\n");

		await first.app.close();

		// 2 回目: 同じ userData / workspace で再起動 → workspace 自動復元 →
		// 同じファイルを再オープンすると編集後の内容がディスクから読み戻される。
		// （タブ自体は永続化対象外なので、ツリーから開き直して内容復元を確認する。）
		const second = await launch(userDataDir);
		await expect(second.page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();
		await second.page.getByLabel("hello.md file").click();
		await expect(second.page.locator(".cm-content")).toContainText("Hello World updated");
	});
});
