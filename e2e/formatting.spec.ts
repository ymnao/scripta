import { expect, test } from "@playwright/test";
import { modKey, TauriMock } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/test.md": "hello world",
	},
	directories: {
		"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
	},
};

test.describe("formatting shortcuts", () => {
	test("Cmd+B wraps selection with bold markers", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		// Wait for editor to load
		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		// Select "world" (characters 6-11)
		await page.keyboard.press("Home");
		for (let i = 0; i < 6; i++) {
			await page.keyboard.press("ArrowRight");
		}
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press("Shift+ArrowRight");
		}

		await page.keyboard.press(`${modKey}+b`);

		// Verify the text contains bold markers
		const text = await editor.textContent();
		expect(text).toContain("**world**");
	});

	test("Cmd+Shift+X wraps selection with strikethrough markers", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		// Select "world" (characters 6-11)
		await page.keyboard.press("Home");
		for (let i = 0; i < 6; i++) {
			await page.keyboard.press("ArrowRight");
		}
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press("Shift+ArrowRight");
		}

		await page.keyboard.press(`${modKey}+Shift+x`);

		// Save and check the actual content via write_file mock
		await page.keyboard.press(`${modKey}+s`);
		await page.waitForTimeout(200);

		const calls = await mock.getCalls("write_file");
		const lastCall = calls[calls.length - 1];
		expect(lastCall.content).toContain("~~world~~");
	});
});
