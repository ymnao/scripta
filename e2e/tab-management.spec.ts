import { expect, test } from "@playwright/test";
import { modKey, TauriMock } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/hello.md": "# Hello World",
		"/workspace/notes.md": "Some notes here",
		"/workspace/todo.md": "- [ ] Task 1",
	},
	directories: {
		"/workspace": [
			{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
			{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
			{ name: "todo.md", path: "/workspace/todo.md", isDirectory: false },
		],
	},
};

test.describe("tab management", () => {
	test("replaces active tab on normal file click", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await expect(page.getByRole("tab", { selected: true })).toContainText("hello.md");

		await page.getByLabel("notes.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await expect(page.getByRole("tab", { selected: true })).toContainText("notes.md");
	});

	test("opens new tab with Cmd+Click", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(1);

		await page.getByLabel("notes.md file").click({ modifiers: ["Meta"] });
		await expect(page.getByRole("tab")).toHaveCount(2);
	});

	test("switches editor content when replacing tab", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.getByLabel("notes.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Some notes here");
	});

	test("switches editor content when switching tabs", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		// Cmd+Click to open in new tab
		await page.getByLabel("notes.md file").click({ modifiers: ["Meta"] });
		await expect(page.locator(".cm-content")).toContainText("Some notes here");

		await page.getByRole("tab").filter({ hasText: "hello.md" }).click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");
	});

	test("closes a tab with the close button", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		// Cmd+Click to open a second tab
		await page.getByLabel("notes.md file").click({ modifiers: ["Meta"] });

		await expect(page.getByRole("tab")).toHaveCount(2);

		await page.getByLabel("Close notes.md").click();
		await expect(page.getByRole("tab")).toHaveCount(1);
	});

	test("closes active tab with Cmd+W", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		// Cmd+Click to open a second tab
		await page.getByLabel("notes.md file").click({ modifiers: ["Meta"] });

		await expect(page.getByRole("tab")).toHaveCount(2);

		await page.keyboard.press(`${modKey}+w`);
		await expect(page.getByRole("tab")).toHaveCount(1);
	});

	test("Cmd+W closes newtab then window when no file tabs remain", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		// newtab is auto-opened — close it first
		await expect(page.getByRole("tab")).toHaveCount(1);
		await page.keyboard.press(`${modKey}+w`);
		await expect(page.getByRole("tab")).toHaveCount(0);

		// No tabs — Cmd+W should trigger window close
		await page.keyboard.press(`${modKey}+w`);
		await page.waitForFunction(() => {
			type W = Window & { __TAURI_WINDOW__?: { closeCalled?: boolean } };
			return (window as W).__TAURI_WINDOW__?.closeCalled === true;
		});
	});

	test("Cmd+Shift+W closes window even with tabs open", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(1);

		await page.keyboard.press(`${modKey}+Shift+w`);

		await page.waitForFunction(() => {
			type W = Window & { __TAURI_WINDOW__?: { closeCalled?: boolean } };
			return (window as W).__TAURI_WINDOW__?.closeCalled === true;
		});
	});

	test("activates existing tab when clicking an already-open file", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		// Cmd+Click to open second tab
		await page.getByLabel("notes.md file").click({ modifiers: ["Meta"] });

		await expect(page.getByRole("tab")).toHaveCount(2);
		await expect(page.getByRole("tab", { selected: true })).toContainText("notes.md");

		// Normal click on already-open file switches to it (no new tab)
		await page.getByLabel("hello.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(2);
		await expect(page.getByRole("tab", { selected: true })).toContainText("hello.md");
	});
});
