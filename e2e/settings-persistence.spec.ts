import { expect, test } from "@playwright/test";
import { ElectronApiMock } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/test.md": "# Hello",
	},
	directories: {
		"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
	},
};

test.describe("settings persistence", () => {
	test("起動時に sidebarVisible=false が復元される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			settings: {
				sidebarVisible: false,
				workspacePath: "/workspace",
			},
		});

		await page.goto("/");
		// NewTabContent の "ワークスペース検索" は hasWorkspace=true のときだけ
		// 描画される。これで workspace の復元成功を検出する。motto + test.md 非表示
		// だけだと「workspace 復元失敗で空状態」と区別がつかず、本来検出したい
		// 「sidebar=false が復元されたが workspace は読み込まれた」を取り逃す。
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();
		// sidebar 非表示なのでファイルツリーも sidebar 内の "フォルダを開く" ボタンも出ない
		await expect(page.getByLabel("test.md file")).not.toBeVisible();
		await expect(page.getByLabel("フォルダを開く")).not.toBeVisible();
	});

	test("起動時に sidebarVisible=true が復元される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			settings: {
				sidebarVisible: true,
				themePreference: "system",
				workspacePath: "/workspace",
			},
		});

		await page.goto("/");
		await expect(page.getByLabel("test.md file")).toBeVisible();
	});

	test("?newWindow=true の場合は workspace を復元しない", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			settings: {
				workspacePath: "/workspace",
				sidebarVisible: true,
			},
		});

		await page.goto("/?newWindow=true");
		// workspace は読み込まれず、Open folder ボタン + motto が表示される
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();
		await expect(page.getByLabel("test.md file")).not.toBeVisible();
		await expect(page.getByLabel("フォルダを開く")).toBeVisible();
	});

	test("保存された workspace パスが無効な場合は空状態にフォールバック", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		// /nonexistent の directory entry を用意しない → listDirectory が throw する
		await mock.setup({
			fs: { files: {}, directories: {} },
			settings: {
				workspacePath: "/nonexistent",
				sidebarVisible: true,
			},
		});

		await page.goto("/");
		// パス検証に失敗して workspace が設定されないので motto が表示される
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();
		await expect(page.getByLabel("フォルダを開く")).toBeVisible();
	});
});
