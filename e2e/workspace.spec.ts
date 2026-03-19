import { expect, test } from "@playwright/test";
import { TauriMock } from "./helpers/tauri-mock";

test.describe("workspace", () => {
	test("displays file tree after opening a workspace", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(
			{
				files: {
					"/workspace/hello.md": "# Hello",
					"/workspace/notes.md": "Some notes",
				},
				directories: {
					"/workspace": [
						{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
						{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
					],
				},
			},
			"/workspace",
		);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await expect(page.getByLabel("hello.md file")).toBeVisible();
		await expect(page.getByLabel("notes.md file")).toBeVisible();
	});

	test("expands a folder to show children", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(
			{
				files: {
					"/workspace/docs/readme.md": "# Readme",
				},
				directories: {
					"/workspace": [{ name: "docs", path: "/workspace/docs", isDirectory: true }],
					"/workspace/docs": [
						{ name: "readme.md", path: "/workspace/docs/readme.md", isDirectory: false },
					],
				},
			},
			"/workspace",
		);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await expect(page.getByLabel("docs folder")).toBeVisible();

		await page.getByLabel("docs folder").click();
		await expect(page.getByLabel("readme.md file")).toBeVisible();
	});

	test("context menu 'フォルダで表示' calls show_in_folder", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(
			{
				files: {
					"/workspace/hello.md": "# Hello",
				},
				directories: {
					"/workspace": [{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false }],
				},
			},
			"/workspace",
		);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click({ button: "right" });
		await page.getByText("フォルダで表示").click();

		const calls = await mock.getCalls("show_in_folder");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ path: "/workspace/hello.md" });
	});

	test("creates a folder via context menu", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(
			{
				files: {
					"/workspace/hello.md": "# Hello",
				},
				directories: {
					"/workspace": [{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false }],
				},
			},
			"/workspace",
		);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await expect(page.getByLabel("hello.md file")).toBeVisible();

		// Right-click on the file tree root area
		await page.getByLabel("hello.md file").click({ button: "right" });
		await page.getByText("New Folder").click();

		// Type folder name and confirm
		const input = page.getByRole("textbox", { name: "New folder name" });
		await expect(input).toBeVisible();
		await input.fill("my-folder");
		await input.press("Enter");

		// Verify create_directory was called (not create_file)
		const dirCalls = await mock.getCalls("create_directory");
		expect(dirCalls).toHaveLength(1);
		expect(dirCalls[0]).toEqual({ path: "/workspace/my-folder" });

		const fileCalls = await mock.getCalls("create_file");
		expect(fileCalls).toHaveLength(0);

		// Verify the folder appears in the tree
		await expect(page.getByLabel("my-folder folder")).toBeVisible();
	});

	test("shows empty state when no workspace is selected", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup({ files: {}, directories: {} }, null);

		await page.goto("/");
		await expect(page.getByText("Open a folder to get started")).toBeVisible();
	});

	test("delete confirmation dialog fits at small viewport", async ({ page }) => {
		await page.setViewportSize({ width: 800, height: 500 });
		const mock = new TauriMock(page);
		await mock.setup(
			{
				files: { "/workspace/hello.md": "# Hello" },
				directories: {
					"/workspace": [{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false }],
				},
			},
			"/workspace",
		);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click({ button: "right" });
		await page.getByText("Delete").click();

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();
		const box = await dialog.boundingBox();
		expect(box?.height).toBeLessThanOrEqual(500);

		// 確認・キャンセルボタンが操作可能であること
		await expect(page.getByRole("button", { name: "キャンセル" })).toBeVisible();
		await expect(page.getByRole("button", { name: "削除" })).toBeVisible();
	});

	test("emoji input dialog fits at small viewport", async ({ page }) => {
		await page.setViewportSize({ width: 800, height: 500 });
		const mock = new TauriMock(page);
		await mock.setup(
			{
				files: { "/workspace/hello.md": "# Hello" },
				directories: {
					"/workspace": [{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false }],
					"/workspace/.scripta": [],
				},
			},
			"/workspace",
		);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click({ button: "right" });
		await page.getByText("アイコンを設定...").click();

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();
		await expect(page.getByText("アイコンを設定")).toBeVisible();
		const box = await dialog.boundingBox();
		expect(box?.height).toBeLessThanOrEqual(500);

		// 絵文字一覧と設定ボタンが操作可能であること
		await expect(page.getByLabel("絵文字一覧")).toBeVisible();
		await expect(page.getByRole("button", { name: "設定" })).toBeVisible();
	});
});
