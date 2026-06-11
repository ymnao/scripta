import { expect, test } from "@playwright/test";
import { ElectronApiMock } from "./helpers/electron-api-mock";

const fs = {
	files: {
		"/workspace/test.md": "# Test",
	},
	directories: {
		"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
	},
};

test.describe("icon button tooltip", () => {
	test("ステータスバーの設定ボタンに hover で tooltip が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await expect(page.getByLabel("test.md file")).toBeVisible();

		const settingsButton = page.getByLabel("設定を開く");
		await settingsButton.hover();

		const tooltip = page.getByRole("tooltip");
		await expect(tooltip).toBeVisible();
		// キー表記（⌘ vs Ctrl）は実行環境 platform 依存なので label のみ assert する
		await expect(tooltip).toContainText("設定");
	});

	test("hover を外すと tooltip が消える", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await expect(page.getByLabel("test.md file")).toBeVisible();

		const settingsButton = page.getByLabel("設定を開く");
		await settingsButton.hover();
		await expect(page.getByRole("tooltip")).toBeVisible();

		// 別要素へ hover を移して tooltip を消す
		await page.getByLabel("test.md file").hover();
		await expect(page.getByRole("tooltip")).not.toBeVisible();
	});
});
