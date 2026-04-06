import { expect, test } from "@playwright/test";
import { modKey, TauriMock } from "./helpers/tauri-mock";

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

test.describe("command palette", () => {
	test("opens with Cmd+P and closes with Escape", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+p`);
		await expect(page.getByLabel("Search files by name")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByLabel("Search files by name")).not.toBeVisible();
	});

	test("shows all files when opened", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+p`);
		await expect(page.getByText("hello.md").first()).toBeVisible();
		await expect(page.getByText("notes.md").first()).toBeVisible();
		await expect(page.getByText("readme.md").first()).toBeVisible();
	});

	test("filters files by typing", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+p`);
		await page.getByLabel("Search files by name").fill("read");

		// readme.md should match, others should not appear in the palette
		await expect(page.getByText("readme.md").first()).toBeVisible();
		// The palette button includes the full path, use it to distinguish from file tree
		await expect(page.getByRole("button", { name: /hello\.md.*\/workspace/ })).not.toBeVisible();
	});

	test("opens file with Enter", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+p`);
		await expect(page.getByLabel("Search files by name")).toBeVisible();

		// Wait for file list to appear
		await expect(page.getByText("hello.md").first()).toBeVisible();
		await page.keyboard.press("Enter");

		// Palette should close and file should be opened
		await expect(page.getByLabel("Search files by name")).not.toBeVisible();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await expect(page.locator(".cm-content")).toContainText("Hello");
	});

	test("closes when clicking backdrop", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+p`);
		await expect(page.getByLabel("Search files by name")).toBeVisible();

		// Click the backdrop area (top-left corner)
		await page.mouse.click(10, 10);
		await expect(page.getByLabel("Search files by name")).not.toBeVisible();
	});
});
