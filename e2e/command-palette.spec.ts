import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/hello.md": "# Hello",
		"/workspace/notes.md": "Notes content",
		"/workspace/readme.md": "# Readme",
	},
	directories: {
		"/workspace": [
			{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
			{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
			{ name: "readme.md", path: "/workspace/readme.md", isDirectory: false },
		],
	},
};

// 背後のファイルツリーには同名のテキストが存在するため、
// パレット内アサーションは listbox / option ロールでスコープして false-positive を避ける。

test.describe("command palette", () => {
	test("Cmd+P で開いて Escape で閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		await page.keyboard.press(`${modKey}+p`);
		await expect(page.getByLabel("ファイル名で検索")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByLabel("ファイル名で検索")).not.toBeVisible();
	});

	test("開いた直後はパレット内に全ファイルが表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		await page.keyboard.press(`${modKey}+p`);
		// パレット内 listbox に絞ってチェックする。.first() で素のテキストを掴むと
		// 背後のファイルツリーで同名要素を拾って false positive になる。
		const options = page.getByRole("listbox", { name: "検索結果" }).getByRole("option");
		await expect(options).toHaveCount(3);
		// 表示順は basename の byte 比較（searchFilenames の仕様）→ hello / notes / readme
		await expect(options.nth(0)).toContainText("hello.md");
		await expect(options.nth(1)).toContainText("notes.md");
		await expect(options.nth(2)).toContainText("readme.md");
	});

	test("入力でファイルが絞り込まれる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		await page.keyboard.press(`${modKey}+p`);
		await page.getByLabel("ファイル名で検索").fill("read");

		// readme.md だけがマッチして、hello.md / notes.md は消える
		const options = page.getByRole("listbox", { name: "検索結果" }).getByRole("option");
		await expect(options).toHaveCount(1);
		await expect(options.nth(0)).toContainText("readme.md");
	});

	test("Enter で選択中の先頭候補が開く", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		await page.keyboard.press(`${modKey}+p`);
		await expect(page.getByLabel("ファイル名で検索")).toBeVisible();

		// Enter 前に「先頭の hello.md が選択されている」ことを保証する。
		// これが無いとファイルが開いたという結果だけで通り、selectedIndex の
		// 初期化バグ（例: index=-1 で 0 番目以外が開く）を取り逃す。
		const listbox = page.getByRole("listbox", { name: "検索結果" });
		const selected = listbox.getByRole("option", { selected: true });
		await expect(selected).toContainText("hello.md");

		await page.keyboard.press("Enter");

		await expect(page.getByLabel("ファイル名で検索")).not.toBeVisible();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await expect(page.locator(".cm-content")).toContainText("Hello");
	});

	test("バックドロップクリックで閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		await page.keyboard.press(`${modKey}+p`);
		await expect(page.getByLabel("ファイル名で検索")).toBeVisible();

		await page.mouse.click(10, 10);
		await expect(page.getByLabel("ファイル名で検索")).not.toBeVisible();
	});
});
