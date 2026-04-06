import { expect, test } from "@playwright/test";
import { modKey, TauriMock } from "./helpers/tauri-mock";

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
	test("displays file content in editor when a file is selected", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");
		await expect(page.getByRole("tab")).toHaveCount(1);
	});

	test("shows 未保存 status after editing", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.locator(".cm-content").click();
		await page.keyboard.type(" updated");

		await expect(page.getByText("未保存")).toBeVisible();
	});

	test("auto-saves after debounce and shows 保存済み status", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.locator(".cm-content").click();
		await page.keyboard.type(" updated");

		await expect(page.getByText("未保存")).toBeVisible();
		await expect(page.getByText("保存済み", { exact: true })).toBeVisible({ timeout: 5000 });

		const calls = await mock.getCalls("write_file");
		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls.some((c) => c.path === "/workspace/hello.md")).toBe(true);
	});

	test("saves immediately with Cmd+S", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.locator(".cm-content").click();
		await page.keyboard.type(" manual");

		await expect(page.getByText("未保存")).toBeVisible();

		await page.keyboard.press(`${modKey}+s`);
		await expect(page.getByText("保存済み", { exact: true })).toBeVisible({ timeout: 3000 });

		const calls = await mock.getCalls("write_file");
		expect(calls.length).toBeGreaterThanOrEqual(1);
	});
});
