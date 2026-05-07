import { expect, test } from "@playwright/test";
import { waitForSaved, waitForUnsaved } from "./helpers/assertions";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/test.md": "first line\n\n## hello\n\nplain text",
		"/workspace/first-line-heading.md": "## first heading\n\nsecond line",
		"/workspace/first-line-blockquote.md": "> first quote\n\nsecond line",
		"/workspace/.scripta/initialized.json": '{"initializedAt":"2026-01-01T00:00:00.000Z"}',
	},
	directories: {
		"/workspace": [
			{ name: "test.md", path: "/workspace/test.md", isDirectory: false },
			{
				name: "first-line-heading.md",
				path: "/workspace/first-line-heading.md",
				isDirectory: false,
			},
			{
				name: "first-line-blockquote.md",
				path: "/workspace/first-line-blockquote.md",
				isDirectory: false,
			},
		],
	},
};

test.describe("heading live preview", () => {
	test("スペース無しの ## には heading-2 デコレーションが付かない", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press(`${modKey}+End`);
		await page.keyboard.press("Enter");
		await page.keyboard.press("Enter");

		await page.keyboard.type("##");

		// "##" 行は heading-2 にならず、元の "## hello" 行のみ
		const headingLines = page.locator(".cm-line.cm-heading-2");
		await expect(headingLines).toHaveCount(1);
	});

	test('"## " 後に文字を入力すると heading-2 デコレーションが効いてマーク部分が隠れる', async ({
		page,
	}) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press(`${modKey}+End`);
		await page.keyboard.press("Enter");
		await page.keyboard.press("Enter");

		await page.keyboard.type("## world");

		// 行外にカーソル移動 → デコレーションが効く
		await page.keyboard.press(`${modKey}+Home`);

		const headingLines = page.locator(".cm-line.cm-heading-2");
		await expect(headingLines).toHaveCount(2, { timeout: 5000 });

		// "## " マークは隠れているので、表示テキストは "## " で始まらない
		const lastHeading = headingLines.last();
		const visibleText = await lastHeading.textContent();
		expect(visibleText).not.toMatch(/^## /);
		expect(visibleText).toContain("world");
	});

	test("Backspace でマークがアトミックに削除される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		const headingLine = page.locator(".cm-line.cm-heading-2");
		await expect(headingLine).toBeVisible({ timeout: 5000 });

		await headingLine.click();
		await page.keyboard.press("Home");

		// "## " アトミック範囲を Backspace で一度に削除
		await page.keyboard.press("Backspace");

		await expect(headingLine).not.toBeVisible({ timeout: 5000 });
		await waitForUnsaved(page);

		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		const calls = await mock.getCalls("writeFile");
		const lastCall = calls[calls.length - 1];
		const content = lastCall[1] as string;
		expect(content).toContain("hello");
		expect(content).not.toContain("## hello");
	});

	test("見出しレベル変更 — 視覚的な行頭で ### を入力すると h3 になる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		const heading2 = page.locator(".cm-line.cm-heading-2");
		await expect(heading2).toBeVisible({ timeout: 5000 });

		await heading2.click();
		await page.keyboard.press("Home");

		await page.keyboard.type("### ");

		await page.keyboard.press(`${modKey}+Home`);

		const heading3 = page.locator(".cm-line.cm-heading-3");
		await expect(heading3).toBeVisible({ timeout: 5000 });
		await expect(heading2).not.toBeVisible({ timeout: 5000 });
	});

	test("先頭行が見出し — Home キーで隠しプレフィクスの内側に入らない", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("first-line-heading.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await page.keyboard.press(`${modKey}+End`);
		const headingLine = page.locator(".cm-line.cm-heading-2");
		await expect(headingLine).toBeVisible({ timeout: 5000 });

		await headingLine.click();
		await page.keyboard.press("Home");

		// 入力された文字は "## " の後ろ（視覚的な行頭）に入る
		await page.keyboard.type("X");
		await waitForUnsaved(page);
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		const calls = await mock.getCalls("writeFile");
		const lastCall = calls[calls.length - 1];
		const content = lastCall[1] as string;
		expect(content).toMatch(/^## X/);
	});

	test("先頭行が見出し — 視覚的な行頭での Left キーでも隠しプレフィクス内に入らない", async ({
		page,
	}) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("first-line-heading.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await page.keyboard.press(`${modKey}+End`);
		const headingLine = page.locator(".cm-line.cm-heading-2");
		await expect(headingLine).toBeVisible({ timeout: 5000 });

		await headingLine.click();
		await page.keyboard.press("Home");
		await page.keyboard.press("ArrowLeft");

		await page.keyboard.type("Y");
		await waitForUnsaved(page);
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		const calls = await mock.getCalls("writeFile");
		const lastCall = calls[calls.length - 1];
		const content = lastCall[1] as string;
		expect(content).toMatch(/^## Y/);
	});

	test("先頭行が引用 — Home キーで視覚的な行頭にカーソルが残る", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("first-line-blockquote.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await page.keyboard.press(`${modKey}+End`);
		const quoteLine = page.locator(".cm-line.cm-blockquote-line");
		await expect(quoteLine).toBeVisible({ timeout: 5000 });

		await quoteLine.click();
		await page.keyboard.press("Home");

		await page.keyboard.type("Z");
		await waitForUnsaved(page);
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		const calls = await mock.getCalls("writeFile");
		const lastCall = calls[calls.length - 1];
		const content = lastCall[1] as string;
		expect(content).toMatch(/^> Z/);
	});

	test("見出し行の視覚的な行頭で Left キーを押すと前の行に移動する", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		const headingLine = page.locator(".cm-line.cm-heading-2");
		await expect(headingLine).toBeVisible({ timeout: 5000 });

		await headingLine.click();
		await page.keyboard.press("Home");

		// Left キーで前の空行へ
		await page.keyboard.press("ArrowLeft");

		await page.keyboard.type("X");
		await waitForUnsaved(page);

		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		const calls = await mock.getCalls("writeFile");
		const lastCall = calls[calls.length - 1];
		const content = lastCall[1] as string;

		// "## hello" の前の空行に "X" が入る → "X\n## hello"
		expect(content).toContain("X\n## hello");
	});
});
