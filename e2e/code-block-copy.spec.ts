import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

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
	test("コピーボタンにフォーカス + Enter でコードがコピーされる", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });
		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("code.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// カーソルをコードブロック外へ
		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		const codeBlockLine = page.locator(".cm-codeblock-line").first();
		await expect(codeBlockLine).toBeVisible();
		await codeBlockLine.hover();

		const copyButton = page.locator(".cm-codeblock-copy");
		await expect(copyButton).toHaveClass(/cm-codeblock-copy-visible/);

		await copyButton.focus();
		await expect(copyButton).toBeFocused();

		await page.keyboard.press("Enter");

		// 成功フィードバック（チェックマーク）
		await expect(copyButton).toHaveClass(/cm-codeblock-copy-success/);

		await page.waitForTimeout(100);
		const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboardText).toBe("const x = 1;");
	});
});
