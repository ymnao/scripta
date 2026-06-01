import { expect, test } from "@playwright/test";
import { waitForSaved, waitForUnsaved } from "./helpers/assertions";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

// #91（マーカー挿入後のカーソル位置）/ #92（Enter によるリスト継続）の
// 振る舞いを実 CodeMirror（renderer-only モード）で固定する。

function makeWorkspace(content: string) {
	return {
		files: {
			"/workspace/test.md": content,
			"/workspace/.scripta/initialized.json": '{"initializedAt":"2026-01-01T00:00:00.000Z"}',
		},
		directories: {
			"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
		},
	};
}

async function lastWrite(mock: ElectronApiMock): Promise<string> {
	const calls = await mock.getCalls("writeFile");
	return calls[calls.length - 1][1] as string;
}

test.describe("マーカー挿入後のカーソル位置 (#91)", () => {
	test("空行で Cmd+L → 入力テキストがマーカーの右に入る", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: makeWorkspace(""), dialogResult: "/workspace" });
		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();
		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		await page.keyboard.press(`${modKey}+l`);
		await page.keyboard.type("task");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("- task");
	});

	test("空行で Cmd+1 → 入力テキストが見出しマーカーの右に入る", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: makeWorkspace(""), dialogResult: "/workspace" });
		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();
		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		await page.keyboard.press(`${modKey}+1`);
		await page.keyboard.type("Title");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("# Title");
	});

	test("空行で Cmd+Shift+L → 入力テキストがタスクマーカーの右に入る", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: makeWorkspace(""), dialogResult: "/workspace" });
		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();
		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		await page.keyboard.press(`${modKey}+Shift+l`);
		await page.keyboard.type("todo");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("- [ ] todo");
	});
});

test.describe("Enter によるリスト継続 (#92)", () => {
	test("リスト項目末尾で Enter → 次行が - で継続", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: makeWorkspace("- foo"), dialogResult: "/workspace" });
		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();
		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("bar");
		await waitForUnsaved(page);
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("- foo\n- bar");
	});

	test("タスクリスト末尾で Enter → 次行が - [ ] で継続", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: makeWorkspace("- [ ] foo"), dialogResult: "/workspace" });
		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();
		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("bar");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("- [ ] foo\n- [ ] bar");
	});

	test("順序付きリスト末尾で Enter → 番号が自動インクリメント", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: makeWorkspace("1. foo"), dialogResult: "/workspace" });
		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();
		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("bar");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("1. foo\n2. bar");
	});

	test("blockquote 末尾で Enter → 次行が > で継続", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: makeWorkspace("> foo"), dialogResult: "/workspace" });
		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();
		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();

		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("bar");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("> foo\n> bar");
	});
});
