import { expect, test } from "@playwright/test";
import { ElectronApiMock } from "./helpers/electron-api-mock";

test.describe("status bar", () => {
	test("編集中はカーソル位置と文字数が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: {
				files: {
					"/workspace/test.md": "Hello\nWorld\nLine 3",
				},
				directories: {
					"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
				},
			},
			dialogResult: "/workspace",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("test.md file").click();

		await expect(page.getByText(/\d+ 行, \d+ 列/)).toBeVisible();
		await expect(page.getByText(/\d+ 文字/)).toBeVisible();
	});

	test("ファイル未選択時はカーソル情報を表示しない", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({});

		await page.goto("/");
		await expect(page.getByText(/\d+ 行, \d+ 列/)).not.toBeVisible();
		await expect(page.getByText(/\d+ 文字/)).not.toBeVisible();
	});

	test("ファイルパスがステータスバーに表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: {
				files: {
					"/workspace/note.md": "Hello World",
				},
				directories: {
					"/workspace": [{ name: "note.md", path: "/workspace/note.md", isDirectory: false }],
				},
			},
			dialogResult: "/workspace",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("note.md file").click();

		await expect(page.getByTestId("file-path")).toHaveText("note.md");
	});

	test("テキスト選択時に選択範囲情報が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: {
				files: {
					"/workspace/test.md": "hello world",
				},
				directories: {
					"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
				},
			},
			dialogResult: "/workspace",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		// "hello"（0-5）を選択
		await page.keyboard.press("Home");
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press("Shift+ArrowRight");
		}

		await expect(page.getByTestId("selection-info")).toBeVisible();
	});
});
