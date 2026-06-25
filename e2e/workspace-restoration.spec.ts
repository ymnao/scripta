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

test.describe("workspace restoration: skip / fallback branches (mocked settings)", () => {
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
