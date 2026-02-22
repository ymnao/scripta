import { expect, test } from "@playwright/test";
import { TauriMock, modKey } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/hello.md": "# Hello World\nThis is a test file\nHello again",
		"/workspace/notes.md": "Some notes here\nhello from notes",
	},
	directories: {
		"/workspace": [
			{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
			{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
		],
	},
};

test.describe("in-file search", () => {
	test("opens search bar with Cmd+F", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.keyboard.press(`${modKey}+f`);
		await expect(page.locator(".search-bar")).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Find" })).toBeVisible();
	});

	test("opens search bar with Cmd+F even when sidebar is focused", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		// Focus the sidebar by clicking a file tree item
		await page.getByLabel("notes.md file").click();
		// Now press Cmd+F — should still open search bar
		await page.keyboard.press(`${modKey}+f`);
		await expect(page.locator(".search-bar")).toBeVisible();
	});

	test("closes search bar with Escape", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await page.keyboard.press(`${modKey}+f`);
		await expect(page.locator(".search-bar")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.locator(".search-bar")).not.toBeVisible();
	});

	test("shows replace field with Cmd+H", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		// Cmd+H should open search bar with replace expanded
		await page.keyboard.press(`${modKey}+h`);
		await expect(page.locator(".search-bar")).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Replace" })).toBeVisible();
	});

	test("shows match count when searching", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.keyboard.press(`${modKey}+f`);
		await page.getByRole("textbox", { name: "Find" }).fill("Hello");
		// Should show match count
		await expect(page.locator(".search-bar-match-count")).toContainText(/\d+ (of \d+|results)/);
	});

	test("navigates between matches with buttons", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.keyboard.press(`${modKey}+f`);
		await page.getByRole("textbox", { name: "Find" }).fill("Hello");

		// Click next match
		await page.getByLabel("Next match").click();
		// The match count should update to show current position
		await expect(page.locator(".search-bar-match-count")).toContainText(/\d+ of \d+/);
	});

	test("toggles replace with expand button", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await page.keyboard.press(`${modKey}+f`);
		await expect(page.locator(".search-bar")).toBeVisible();

		// Replace should not be visible initially (Cmd+F opens collapsed)
		await expect(page.getByRole("textbox", { name: "Replace" })).not.toBeVisible();

		// Click expand button
		await page.getByLabel("Expand replace").click();
		await expect(page.getByRole("textbox", { name: "Replace" })).toBeVisible();

		// Click collapse button
		await page.getByLabel("Collapse replace").click();
		await expect(page.getByRole("textbox", { name: "Replace" })).not.toBeVisible();
	});
});

test.describe("workspace search", () => {
	test("opens search panel with Cmd+Shift+F", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+Shift+f`);
		// Sidebar header should switch to "Search"
		await expect(page.getByText("Search", { exact: true })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Search in workspace" })).toBeVisible();
	});

	test("opens search panel via magnifying glass icon", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.getByLabel("Search in workspace").click();
		await expect(page.getByText("Search", { exact: true })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Search in workspace" })).toBeVisible();
	});

	test("shows search results grouped by file", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+Shift+f`);
		await page.getByRole("textbox", { name: "Search in workspace" }).fill("hello");

		// Wait for debounced search results
		await expect(page.locator(".search-panel-file-header")).toHaveCount(2, { timeout: 5000 });
		// Both files should appear
		await expect(page.locator(".search-panel-file-header").first()).toContainText("hello.md");
		await expect(page.locator(".search-panel-file-header").last()).toContainText("notes.md");
	});

	test("navigates to file and line on result click", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+Shift+f`);
		await page.getByRole("textbox", { name: "Search in workspace" }).fill("hello");

		// Wait for results
		await expect(page.locator(".search-panel-match").first()).toBeVisible({ timeout: 5000 });

		// Click first match
		await page.locator(".search-panel-match").first().click();

		// File should be opened in the editor
		await expect(page.locator(".cm-content")).toContainText("Hello World");
	});

	test("highlights correct text when line contains surrogate pairs", async ({ page }) => {
		const emojiWorkspace = {
			files: {
				"/workspace/emoji.md": "😀hello world\n🎉🎊 test file\nnormal line hello",
			},
			directories: {
				"/workspace": [{ name: "emoji.md", path: "/workspace/emoji.md", isDirectory: false }],
			},
		};
		const mock = new TauriMock(page);
		await mock.setup(emojiWorkspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+Shift+f`);
		await page.getByRole("textbox", { name: "Search in workspace" }).fill("hello");

		// Wait for results
		const highlights = page.locator(".search-panel-highlight");
		await expect(highlights.first()).toBeVisible({ timeout: 5000 });

		// Each <mark> should contain exactly "hello", not garbled surrogate pair fragments
		await expect(highlights).toHaveCount(2);
		await expect(highlights.nth(0)).toHaveText("hello");
		await expect(highlights.nth(1)).toHaveText("hello");
	});

	test("highlights correct text for query after multiple emoji", async ({ page }) => {
		const emojiWorkspace = {
			files: {
				"/workspace/emoji.md": "🎉🎊test",
			},
			directories: {
				"/workspace": [{ name: "emoji.md", path: "/workspace/emoji.md", isDirectory: false }],
			},
		};
		const mock = new TauriMock(page);
		await mock.setup(emojiWorkspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+Shift+f`);
		await page.getByRole("textbox", { name: "Search in workspace" }).fill("test");

		const highlight = page.locator(".search-panel-highlight");
		await expect(highlight).toBeVisible({ timeout: 5000 });
		await expect(highlight).toHaveText("test");
	});

	test("returns to file explorer when clicking files icon", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		// Open search
		await page.getByRole("button", { name: "Search in workspace" }).click();
		await expect(page.getByText("Search", { exact: true })).toBeVisible();

		// Switch back to files
		await page.getByRole("button", { name: "Show file explorer" }).click();
		await expect(page.getByText("Files")).toBeVisible();
	});
});
