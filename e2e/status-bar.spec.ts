import { expect, test } from "@playwright/test";
import { TauriMock, modKey } from "./helpers/tauri-mock";

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

	test("shows file path in status bar", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(
			{
				files: {
					"/workspace/note.md": "Hello World",
				},
				directories: {
					"/workspace": [{ name: "note.md", path: "/workspace/note.md", isDirectory: false }],
				},
			},
			"/workspace",
		);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("note.md file").click();

		await expect(page.getByTestId("file-path")).toHaveText("note.md");
	});

	test("shows selection info when text is selected", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(
			{
				files: {
					"/workspace/test.md": "hello world",
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

		// Wait for editor and click to focus (same pattern as formatting tests)
		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		// Select "hello" (characters 0-5) using same pattern as formatting tests
		await page.keyboard.press("Home");
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press("Shift+ArrowRight");
		}

		await expect(page.getByTestId("selection-info")).toBeVisible();
	});
});
