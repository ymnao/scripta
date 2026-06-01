import { expect, type Page, test } from "@playwright/test";
import { waitForSaved } from "./helpers/assertions";
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

// 指定内容の test.md を開き、エディタにフォーカスした状態を返す。
async function openWithContent(page: Page, content: string): Promise<ElectronApiMock> {
	const mock = new ElectronApiMock(page);
	await mock.setup({ fs: makeWorkspace(content), dialogResult: "/workspace" });
	await page.goto("/");
	await page.getByLabel("Open folder").click();
	await page.getByLabel("test.md file").click();
	const editor = page.locator(".cm-content");
	await expect(editor).toBeVisible();
	await editor.click();
	return mock;
}

async function lastWrite(mock: ElectronApiMock): Promise<string> {
	const calls = await mock.getCalls("writeFile");
	return calls[calls.length - 1][1] as string;
}

test.describe("マーカー挿入後のカーソル位置 (#91)", () => {
	test("空行で Cmd+L → 入力テキストがマーカーの右に入る", async ({ page }) => {
		const mock = await openWithContent(page, "");

		await page.keyboard.press(`${modKey}+l`);
		await page.keyboard.type("task");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("- task");
	});

	test("空行で Cmd+1 → 入力テキストが見出しマーカーの右に入る", async ({ page }) => {
		const mock = await openWithContent(page, "");

		await page.keyboard.press(`${modKey}+1`);
		await page.keyboard.type("Title");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("# Title");
	});

	// 注: Cmd+Shift+L（toggleCheckbox）の e2e は意図的に置かない。
	// CM6 の keymap は Shift+文字キーを正しいバインディングに解決する際
	// keyCode→基底キー名マップ（過去のキー入力から動的構築）に依存するため、
	// ファイルを開いて即ショートカットを押す synthetic event 環境では解決が
	// 不安定になる（CI Linux で Mod-l に誤フォールバックする）。
	// toggleCheckbox のカーソル位置は formatting-commands.test.ts で決定的に
	// 検証しており、dispatchKeepingCursorRight 機構は上記 Cmd+L / Cmd+1 が
	// 同ヘルパー経由で end-to-end に担保している。
});

test.describe("Enter によるリスト継続 (#92)", () => {
	test("リスト項目末尾で Enter → 次行が - で継続", async ({ page }) => {
		const mock = await openWithContent(page, "- foo");

		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("bar");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("- foo\n- bar");
	});

	test("タスクリスト末尾で Enter → 次行が - [ ] で継続", async ({ page }) => {
		const mock = await openWithContent(page, "- [ ] foo");

		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("bar");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("- [ ] foo\n- [ ] bar");
	});

	test("順序付きリスト末尾で Enter → 番号が自動インクリメント", async ({ page }) => {
		const mock = await openWithContent(page, "1. foo");

		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("bar");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("1. foo\n2. bar");
	});

	test("blockquote 末尾で Enter → 次行が > で継続", async ({ page }) => {
		const mock = await openWithContent(page, "> foo");

		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("bar");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("> foo\n> bar");
	});
});
