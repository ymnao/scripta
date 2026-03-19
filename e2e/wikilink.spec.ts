import { expect, test } from "@playwright/test";
import { TauriMock } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/note.md": "# Note\n\nThis is a note.",
		"/workspace/index.md":
			"# Index\n\nLink to [[note]]\n\nAlias [[note|My Note]]\n\nMissing [[nonexistent]]\n\nNoSpace abc[[note]]def",
	},
	directories: {
		"/workspace": [
			{ name: "note.md", path: "/workspace/note.md", isDirectory: false },
			{ name: "index.md", path: "/workspace/index.md", isDirectory: false },
		],
	},
};

test.describe("wikilink preview", () => {
	test("renders [[page]] as a link when cursor is away", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("index.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Place cursor on the first line (away from wikilinks)
		await editor.click();
		await page.keyboard.press("Home");

		// Wait for wikilink rendering
		await expect(page.locator(".cm-wikilink").first()).toBeVisible({ timeout: 5000 });
	});

	test("renders no-space wikilink without editor focus", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("index.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Do NOT click on the editor — no focus
		// Wait for wikilink rendering
		await expect(page.locator(".cm-wikilink").first()).toBeVisible({ timeout: 5000 });

		// All 4 wikilinks should render: [[note]], [[note|My Note]], [[nonexistent]], abc[[note]]def
		const wikilinkCount = await page.locator(".cm-wikilink").count();
		expect(wikilinkCount).toBeGreaterThanOrEqual(4);
	});

	test("clicking missing wikilink opens directory picker dialog", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("index.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Place cursor on the first line
		await editor.click();
		await page.keyboard.press("Home");

		// Click the missing wikilink
		const missingLink = page.locator(".cm-wikilink-missing").first();
		await expect(missingLink).toBeVisible({ timeout: 5000 });
		await missingLink.click();

		// Verify directory picker dialog appears
		await expect(page.getByText("作成先を選択")).toBeVisible({ timeout: 5000 });

		// Confirm creation at root
		await page.getByRole("button", { name: "作成" }).click();

		// Verify navigation occurred (editor shows content from new file)
		await expect(page.getByRole("tab", { selected: true })).toContainText("nonexistent.md", {
			timeout: 5000,
		});
	});

	test("navigates to linked file on click", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("index.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Place cursor on the first line
		await editor.click();
		await page.keyboard.press("Home");

		// Wait for wikilink to render as existing (fileMap populated)
		const wikilink = page.locator(".cm-wikilink:not(.cm-wikilink-missing)").first();
		await expect(wikilink).toBeVisible({ timeout: 5000 });
		await wikilink.click();

		// Verify navigation: the editor should now show note.md content
		await expect(editor).toContainText("This is a note", { timeout: 5000 });
	});
});
