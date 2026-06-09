import { expect, test } from "@playwright/test";
import { waitForSaved, waitForUnsaved } from "./helpers/assertions";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/test.md": "hello world",
		// initialized.json を fileExists 経由で見つけられれば Setup Wizard が
		// 開かないので editor 操作の邪魔にならない。
		"/workspace/.scripta/initialized.json": '{"initializedAt":"2026-01-01T00:00:00.000Z"}',
	},
	directories: {
		"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
	},
};

test.describe("formatting shortcuts", () => {
	test("Cmd+B で選択範囲を太字マーカーで囲む", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		// "world" (6-11 文字目) を選択
		await page.keyboard.press("Home");
		for (let i = 0; i < 6; i++) {
			await page.keyboard.press("ArrowRight");
		}
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press("Shift+ArrowRight");
		}

		await page.keyboard.press(`${modKey}+b`);
		await waitForUnsaved(page);

		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		const calls = await mock.getCalls("writeFile");
		const lastCall = calls[calls.length - 1];
		expect(lastCall[1]).toContain("**world**");
	});

	test("Cmd+Shift+X で選択範囲を取り消し線マーカーで囲む", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		await page.keyboard.press("Home");
		for (let i = 0; i < 6; i++) {
			await page.keyboard.press("ArrowRight");
		}
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press("Shift+ArrowRight");
		}

		await page.keyboard.press(`${modKey}+Shift+x`);
		await waitForUnsaved(page);

		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		const calls = await mock.getCalls("writeFile");
		const lastCall = calls[calls.length - 1];
		expect(lastCall[1]).toContain("~~world~~");
	});
});
