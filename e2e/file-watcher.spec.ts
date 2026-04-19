import { expect, test } from "@playwright/test";
import { waitForUnsaved } from "./helpers/assertions";
import { TauriMock } from "./helpers/tauri-mock";

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

test.describe("file watcher", () => {
	test("file create is reflected in the file tree", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await expect(page.getByLabel("hello.md file")).toBeVisible();

		await mock.simulateFileCreate(
			"/workspace/new-file.md",
			"# New File",
			"/workspace",
			"new-file.md",
		);

		await expect(page.getByLabel("new-file.md file")).toBeVisible({ timeout: 2000 });
	});

	test("file modify updates editor content for clean tab", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await mock.simulateFileModify("/workspace/hello.md", "# Updated Content");

		await expect(page.locator(".cm-content")).toContainText("Updated Content", { timeout: 2000 });
	});

	test("file delete closes clean tab", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.getByRole("tab")).toHaveCount(1);

		await mock.simulateFileDelete("/workspace/hello.md", "/workspace", "hello.md");

		await expect(page.getByRole("tab")).toHaveCount(0, { timeout: 2000 });
	});

	test("file modify on dirty tab shows conflict dialog", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.locator(".cm-content").click();
		await page.keyboard.type(" edited");

		await waitForUnsaved(page);

		await mock.simulateFileModify("/workspace/hello.md", "# External Change");

		await expect(page.getByText("ファイルが外部で変更されました")).toBeVisible({ timeout: 2000 });
		await expect(page.getByRole("button", { name: "再読み込み" })).toBeVisible();
		await expect(page.getByRole("button", { name: "自分の変更を保持" })).toBeVisible();
	});

	test("file delete on dirty tab shows delete dialog", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.locator(".cm-content").click();
		await page.keyboard.type(" edited");

		await waitForUnsaved(page);

		await mock.simulateFileDelete("/workspace/hello.md", "/workspace", "hello.md");

		await expect(page.getByText("ファイルが外部で削除されました")).toBeVisible({ timeout: 2000 });
		await expect(page.getByRole("button", { name: "破棄" })).toBeVisible();
		await expect(page.getByRole("button", { name: "編集を続ける" })).toBeVisible();
	});

	test("workspace switch starts a new watcher", async ({ page }) => {
		// Note: stop_watcher (cleanup) is verified in useFileWatcher.test.ts (unit test).
		// E2E cannot observe it because each page.goto() creates a fresh __TAURI_MOCK__
		// context, and React cleanup effects are not guaranteed to run during full
		// page navigation.

		// --- workspace1 ---
		const mock1 = new TauriMock(page);
		await mock1.setup(
			{
				files: { "/workspace1/a.md": "# A" },
				directories: {
					"/workspace1": [{ name: "a.md", path: "/workspace1/a.md", isDirectory: false }],
				},
			},
			"/workspace1",
		);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await expect(page.getByLabel("a.md file")).toBeVisible();

		const calls1 = await mock1.getCalls("start_watcher");
		expect(calls1.some((c) => c.path === "/workspace1")).toBe(true);

		await mock1.simulateFileCreate("/workspace1/b.md", "# B", "/workspace1", "b.md");
		await expect(page.getByLabel("b.md file")).toBeVisible({ timeout: 2000 });

		// --- workspace2 ---
		const mock2 = new TauriMock(page);
		await mock2.setup(
			{
				files: { "/workspace2/x.md": "# X" },
				directories: {
					"/workspace2": [{ name: "x.md", path: "/workspace2/x.md", isDirectory: false }],
				},
			},
			"/workspace2",
		);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await expect(page.getByLabel("x.md file")).toBeVisible();

		const calls2 = await mock2.getCalls("start_watcher");
		expect(calls2.some((c) => c.path === "/workspace2")).toBe(true);

		await mock2.simulateFileCreate("/workspace2/y.md", "# Y", "/workspace2", "y.md");
		await expect(page.getByLabel("y.md file")).toBeVisible({ timeout: 2000 });
	});
});
