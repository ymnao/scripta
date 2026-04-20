import { expect, test } from "@playwright/test";
import { modKey, TauriMock } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/code.md": "# Title\n\n```js\nconst x = 1;\n```\n",
		"/workspace/.scripta/.initialized": "",
		"/workspace/.scripta/initialized.json": '{"initializedAt":"2026-01-01T00:00:00.000Z"}',
	},
	directories: {
		"/workspace": [{ name: "code.md", path: "/workspace/code.md", isDirectory: false }],
		"/workspace/.scripta": [],
	},
};

test.describe("code block copy button", () => {
	test("copies code via focused button and Enter", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");
		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("code.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// カーソルをコードブロック外に移動
		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		// コピーボタンがコードブロックホバーで表示される
		const codeBlockLine = page.locator(".cm-codeblock-line").first();
		await expect(codeBlockLine).toBeVisible();
		await codeBlockLine.hover();

		const copyButton = page.locator(".cm-codeblock-copy");
		await expect(copyButton).toBeVisible();

		// コピーボタンにフォーカス → Enter でコピー
		await copyButton.focus();
		await expect(copyButton).toBeFocused();

		await page.keyboard.press("Enter");

		// 成功フィードバック（チェックマーク表示）
		await expect(copyButton).toHaveClass(/cm-codeblock-copy-success/);

		// 実クリップボードの内容を検証
		await page.waitForTimeout(100);
		const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboardText).toBe("const x = 1;");
	});
});
