import { expect, test } from "@playwright/test";
import { TauriMock } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/test.md": "# Hello",
	},
	directories: {
		"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
	},
};

test.describe("settings persistence", () => {
	test("restores sidebar hidden state from settings", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", {
			sidebarVisible: false,
			workspacePath: "/workspace",
		});

		await page.goto("/");
		// Workspace should be restored but sidebar should be hidden
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();
		await expect(page.getByLabel("test.md file")).not.toBeVisible();
	});

	test("restores sidebar visible state from settings", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", {
			sidebarVisible: true,
			themePreference: "system",
			workspacePath: "/workspace",
		});

		await page.goto("/");
		await expect(page.getByLabel("test.md file")).toBeVisible();
	});

	test("new window skips workspace restoration", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, null, {
			workspacePath: "/workspace",
			sidebarVisible: true,
		});

		// Navigate with newWindow query param
		await page.goto("/?newWindow=true");
		// Should show motto — no workspace loaded
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();
		await expect(page.getByLabel("test.md file")).not.toBeVisible();
		// Should NOT have the "Open folder" button area showing workspace files
		await expect(page.getByLabel("Open folder")).toBeVisible();
	});

	test("falls back to empty state when saved workspace path is invalid", async ({ page }) => {
		const mock = new TauriMock(page);
		// Set up with NO directory entry for "/nonexistent" — listDirectory will throw
		await mock.setup({ files: {}, directories: {} }, null, {
			workspacePath: "/nonexistent",
			sidebarVisible: true,
		});

		await page.goto("/");
		// Should show motto since the path validation failed and no workspace is set
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();
		await expect(page.getByLabel("Open folder")).toBeVisible();
	});
});
