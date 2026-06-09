import { expect, test } from "@playwright/test";
import { waitForSaved, waitForUnsaved } from "./helpers/assertions";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/hello.md": "# Hello World",
		"/workspace/notes.md": "Some notes here",
	},
	directories: {
		"/workspace": [
			{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
			{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
		],
	},
};

test.describe("file editing", () => {
	test("ファイルを選択するとエディタに内容が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");
		await expect(page.getByRole("tab")).toHaveCount(1);
	});

	test("編集すると「未保存」ステータスになる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.locator(".cm-content").click();
		await page.keyboard.type(" updated");

		await waitForUnsaved(page);
	});

	test("debounce 後に autosave で正しい内容が書き込まれる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.locator(".cm-content").click();
		await page.keyboard.type(" updated");

		await waitForUnsaved(page);
		await waitForSaved(page, 5000);

		const calls = await mock.getCalls("writeFile");
		expect(calls.length).toBeGreaterThanOrEqual(1);
		// processContent (trimTrailingWhitespace + 末尾改行保証) 適用後のペイロード。
		// 単純な「>= 1 回呼ばれた」だけでは内容ズレや誤ファイル書き込みが通ってしまう。
		const last = calls[calls.length - 1];
		expect(last[0]).toBe("/workspace/hello.md");
		expect(last[1]).toBe("# Hello World updated\n");
	});

	test("Cmd+S で autosave debounce より先に保存される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.locator(".cm-content").click();
		await page.keyboard.type(" manual");

		await waitForUnsaved(page);

		await page.keyboard.press(`${modKey}+s`);
		// autosave のデフォルト debounce は 2000ms。1000ms 以内に writeFile が
		// 走ったことを確認することで、Cmd+S が debounce を待たず即座に saveNow を
		// 呼んでいることを検証する。Cmd+S のハンドラが壊れて autosave 任せに
		// なった場合、この poll が 1000ms で timeout して回帰を検知できる。
		await expect
			.poll(async () => (await mock.getCalls("writeFile")).length, { timeout: 1000 })
			.toBe(1);
		await waitForSaved(page);

		const calls = await mock.getCalls("writeFile");
		expect(calls[0][0]).toBe("/workspace/hello.md");
		expect(calls[0][1]).toBe("# Hello World manual\n");
	});
});
