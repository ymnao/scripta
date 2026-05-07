import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

test.describe("sidebar toggle", () => {
	test("Cmd+B でサイドバーが開閉する", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: {
				files: {
					"/workspace/test.md": "# Test",
				},
				directories: {
					"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
				},
			},
			dialogResult: "/workspace",
		});

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await expect(page.getByLabel("test.md file")).toBeVisible();

		await page.keyboard.press(`${modKey}+b`);
		await expect(page.getByLabel("test.md file")).not.toBeVisible();

		await page.keyboard.press(`${modKey}+b`);
		await expect(page.getByLabel("test.md file")).toBeVisible();
	});
});
