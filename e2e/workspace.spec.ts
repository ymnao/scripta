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

	test("shows empty state when no workspace is selected", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup({ files: {}, directories: {} }, null);

		await page.goto("/");
		await expect(page.getByText("Open a folder to get started")).toBeVisible();
	});
});
