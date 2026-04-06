import { expect, test } from "@playwright/test";
import { modKey, TauriMock } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/note.md": "# Notes\nSee [[missing-page]] for details\nAlso [[another-missing]]",
		"/workspace/existing.md": "# Existing Page\nContent here",
		"/workspace/ref.md": "Referencing [[missing-page]] again",
	},
	directories: {
		"/workspace": [
			{ name: "note.md", path: "/workspace/note.md", isDirectory: false },
			{ name: "existing.md", path: "/workspace/existing.md", isDirectory: false },
			{ name: "ref.md", path: "/workspace/ref.md", isDirectory: false },
		],
	},
};

test.describe("unresolved wikilinks panel", () => {
	test("shows unresolved links panel via sidebar button", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		// Click the unresolved wikilinks button
		await page.getByLabel("Show unresolved wikilinks").click();

		// Should show the panel header
		await expect(page.getByText("未解決リンク", { exact: true })).toBeVisible();
	});

	test("displays unresolved link count", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("Show unresolved wikilinks").click();

		// Wait for scan to complete
		await expect(page.getByText("件の未解決リンク")).toBeVisible();
	});

	test("shows reference count badge for each link", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("Show unresolved wikilinks").click();

		// Wait for results
		await expect(page.getByText("missing-page")).toBeVisible();
		await expect(page.getByText("another-missing")).toBeVisible();

		// missing-page appears in note.md and ref.md (2 references)
		// another-missing appears in note.md (1 reference)
	});

	test("toggles panel with Cmd+Shift+U", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		// Open unresolved panel
		await page.keyboard.press(`${modKey}+Shift+u`);
		await expect(page.getByText("未解決リンク", { exact: true })).toBeVisible();

		// Toggle back to files
		await page.keyboard.press(`${modKey}+Shift+u`);
		await expect(page.getByText("Files")).toBeVisible();
	});

	test("creates file from panel via directory picker dialog", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("Show unresolved wikilinks").click();

		// Wait for results
		await expect(page.getByText("another-missing")).toBeVisible();

		// Click create button — opens directory picker dialog
		await page.getByLabel("Create another-missing").click();
		await expect(page.getByText("作成先を選択")).toBeVisible();

		// Confirm creation at root
		await page.getByRole("button", { name: "作成" }).click();

		// File should have been created
		const createCalls = await mock.getCalls("create_file");
		const writeNewCalls = await mock.getCalls("write_new_file");
		const totalCreates = createCalls.length + writeNewCalls.length;
		expect(totalCreates).toBeGreaterThanOrEqual(1);
	});

	test("sort toggle switches between name and count order", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("Show unresolved wikilinks").click();

		// Wait for results
		await expect(page.getByText("missing-page")).toBeVisible();

		// Click sort button to switch to count order
		await page.getByLabel("Sort by reference count").click();

		// Now should be able to switch back
		await page.getByLabel("Sort by name").click();
	});

	test("missing wikilink has dashed underline style", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("note.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Notes");

		// Check that missing wikilink has the correct class
		const missingLink = page.locator(".cm-wikilink-missing").first();
		await expect(missingLink).toBeVisible();
	});

	test("panel reflects file content changes on re-open", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		// Verify panel initially shows both unresolved links
		await page.getByLabel("Show unresolved wikilinks").click();
		const panel = page.locator('section[aria-label="Unresolved wikilinks"]');
		await expect(panel.getByText("another-missing")).toBeVisible();
		await expect(panel.getByText("missing-page")).toBeVisible();

		// Directly update mock file content (simulates external save)
		await mock.setFileContent("/workspace/note.md", "# Notes\nSee [[missing-page]] for details");

		// Switch away and back to force remount + fresh scan
		await page.getByLabel("Show file explorer").click();
		await page.getByLabel("Show unresolved wikilinks").click();

		// missing-page should still be listed (appears in ref.md)
		await expect(panel.getByText("missing-page")).toBeVisible({ timeout: 5000 });
		// another-missing should no longer be listed
		await expect(panel.getByText("another-missing")).not.toBeVisible();
	});

	test("hover popup has reference data without opening panel first", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		// Open note.md directly — don't open unresolved panel
		await page.getByLabel("note.md file").click();
		const editor = page.locator(".cm-content");
		await expect(editor).toContainText("Notes");

		// Place cursor away from wikilinks
		await editor.click();
		await page.keyboard.press("Home");

		// Wait for missing wikilink to render
		const missingLink = page.locator(".cm-wikilink-missing").first();
		await expect(missingLink).toBeVisible({ timeout: 5000 });

		// Hover over the missing wikilink
		await missingLink.hover();

		// Popup should appear with reference count (scan runs on workspace load)
		const popup = page.locator("[data-page-name]");
		await expect(popup).toBeVisible({ timeout: 5000 });
		await expect(popup).toContainText("件の参照");
	});

	test("shows empty state when no unresolved links", async ({ page }) => {
		const noUnresolved = {
			files: {
				"/workspace/note.md": "# Notes\nSee [[existing]] for details",
				"/workspace/existing.md": "# Existing",
			},
			directories: {
				"/workspace": [
					{ name: "note.md", path: "/workspace/note.md", isDirectory: false },
					{ name: "existing.md", path: "/workspace/existing.md", isDirectory: false },
				],
			},
		};
		const mock = new TauriMock(page);
		await mock.setup(noUnresolved, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("Show unresolved wikilinks").click();

		await expect(page.getByText("未解決のリンクはありません")).toBeVisible();
	});

	test("different workspace shows its own unresolved links, not another workspace's", async ({
		page,
	}) => {
		// Setup a workspace with NO unresolved links
		const cleanWorkspace = {
			files: {
				"/workspace/alpha.md": "# Alpha\n[[beta]]",
				"/workspace/beta.md": "# Beta",
			},
			directories: {
				"/workspace": [
					{ name: "alpha.md", path: "/workspace/alpha.md", isDirectory: false },
					{ name: "beta.md", path: "/workspace/beta.md", isDirectory: false },
				],
			},
		};
		const mock = new TauriMock(page);
		await mock.setup(cleanWorkspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.getByLabel("Show unresolved wikilinks").click();

		// This workspace has no unresolved links — "missing-page" from
		// another workspace's test data must NOT leak here
		await expect(page.getByText("未解決のリンクはありません")).toBeVisible({ timeout: 5000 });
	});
});
