import { expect, test } from "@playwright/test";
import { TauriMock, modKey } from "./helpers/tauri-mock";

test.describe("sidebar toggle", () => {
	test("Cmd+B toggles sidebar visibility", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(
			{
				files: {
					"/workspace/test.md": "# Test",
				},
				directories: {
					"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
				},
			},
			"/workspace",
		);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await expect(page.getByLabel("test.md file")).toBeVisible();

		// Toggle sidebar off
		await page.keyboard.press(`${modKey}+b`);
		await expect(page.getByLabel("test.md file")).not.toBeVisible();

		// Toggle sidebar on
		await page.keyboard.press(`${modKey}+b`);
		await expect(page.getByLabel("test.md file")).toBeVisible();
	});
});
