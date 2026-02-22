import { expect, test } from "@playwright/test";
import { TauriMock } from "./helpers/tauri-mock";

test.describe("status bar", () => {
	test("shows cursor position and character count when editing", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(
			{
				files: {
					"/workspace/test.md": "Hello\nWorld\nLine 3",
				},
				directories: {
					"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
				},
			},
			"/workspace",
		);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		// Wait for the editor to load and cursor info to appear
		await expect(page.getByText(/Ln \d+, Col \d+/)).toBeVisible();
		await expect(page.getByText(/\d+ chars/)).toBeVisible();
	});

	test("does not show cursor info when no file is open", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup({ files: {}, directories: {} }, null);

		await page.goto("/");
		await expect(page.getByText(/Ln \d+, Col \d+/)).not.toBeVisible();
		await expect(page.getByText(/\d+ chars/)).not.toBeVisible();
	});
});
