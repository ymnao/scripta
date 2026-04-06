import { expect, test } from "@playwright/test";
import { modKey, TauriMock } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/test.md": "first line\n\n## hello\n\nplain text",
		"/workspace/first-line-heading.md": "## first heading\n\nsecond line",
		"/workspace/first-line-blockquote.md": "> first quote\n\nsecond line",
	},
	directories: {
		"/workspace": [
			{ name: "test.md", path: "/workspace/test.md", isDirectory: false },
			{
				name: "first-line-heading.md",
				path: "/workspace/first-line-heading.md",
				isDirectory: false,
			},
			{
				name: "first-line-blockquote.md",
				path: "/workspace/first-line-blockquote.md",
				isDirectory: false,
			},
		],
	},
};

test.describe("heading live preview", () => {
	test("no decoration before space — ## without space has no heading class", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Move cursor to the end of the document and add a new line
		await editor.click();
		await page.keyboard.press(`${modKey}+End`);
		await page.keyboard.press("Enter");
		await page.keyboard.press("Enter");

		// Type "##" without a trailing space
		await page.keyboard.type("##");

		// The line with "##" should NOT have heading-2 decoration
		const headingLines = page.locator(".cm-line.cm-heading-2");
		// Only the original "## hello" line should have the heading class
		await expect(headingLines).toHaveCount(1);
	});

	test("decoration after space — ## with space and text gets heading class and hides marks", async ({
		page,
	}) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Move cursor to the end and create a new heading
		await editor.click();
		await page.keyboard.press(`${modKey}+End`);
		await page.keyboard.press("Enter");
		await page.keyboard.press("Enter");

		// Type "## " followed by text
		await page.keyboard.type("## world");

		// Move cursor away from the new heading line to trigger decoration
		await page.keyboard.press(`${modKey}+Home`);

		// Wait for the heading decoration to appear
		const headingLines = page.locator(".cm-line.cm-heading-2");
		await expect(headingLines).toHaveCount(2, { timeout: 5000 });

		// The "## " marks should be hidden — visible text should not start with "## "
		const lastHeading = headingLines.last();
		const visibleText = await lastHeading.textContent();
		expect(visibleText).not.toMatch(/^## /);
		expect(visibleText).toContain("world");
	});

	test("backspace deletes marks atomically", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Move cursor away first so heading decoration is active
		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		// Wait for the heading decoration on "## hello"
		const headingLine = page.locator(".cm-line.cm-heading-2");
		await expect(headingLine).toBeVisible({ timeout: 5000 });

		// Click on the heading line text to position cursor there
		await headingLine.click();
		await page.keyboard.press("Home");

		// Now cursor should be at the visual start of "hello" (after hidden "## ")
		// Press Backspace — the atomic range should delete "## " together
		await page.keyboard.press("Backspace");

		// The line should become plain text "hello" without heading decoration
		await expect(headingLine).not.toBeVisible({ timeout: 5000 });

		// Save and verify the content
		await page.keyboard.press(`${modKey}+s`);
		await page.waitForTimeout(200);

		const calls = await mock.getCalls("write_file");
		const lastCall = calls[calls.length - 1];
		expect(lastCall.content).toContain("hello");
		expect(lastCall.content).not.toContain("## hello");
	});

	test("heading level override — typing ### at visual start changes to h3", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Move cursor away so heading decoration is active
		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		// Wait for the heading-2 decoration
		const heading2 = page.locator(".cm-line.cm-heading-2");
		await expect(heading2).toBeVisible({ timeout: 5000 });

		// Click on the heading line and go to visual start
		await heading2.click();
		await page.keyboard.press("Home");

		// Type "### " to override the heading level
		await page.keyboard.type("### ");

		// Move cursor away so decoration updates
		await page.keyboard.press(`${modKey}+Home`);

		// Should now be heading-3 instead of heading-2
		const heading3 = page.locator(".cm-line.cm-heading-3");
		await expect(heading3).toBeVisible({ timeout: 5000 });
		await expect(heading2).not.toBeVisible({ timeout: 5000 });
	});

	test("first-line heading — Home keeps cursor at visual start, not inside hidden prefix", async ({
		page,
	}) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("first-line-heading.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Move cursor away so decoration is active
		await page.keyboard.press(`${modKey}+End`);
		const headingLine = page.locator(".cm-line.cm-heading-2");
		await expect(headingLine).toBeVisible({ timeout: 5000 });

		// Click on the heading and press Home
		await headingLine.click();
		await page.keyboard.press("Home");

		// Type a character — it should appear at the visual start (after hidden "## "),
		// not inside the hidden prefix
		await page.keyboard.type("X");
		await page.keyboard.press(`${modKey}+s`);
		await page.waitForTimeout(200);

		const calls = await mock.getCalls("write_file");
		const lastCall = calls[calls.length - 1];
		const content = lastCall.content as string;
		// "X" should be after "## ", making it "## Xfirst heading"
		expect(content).toMatch(/^## X/);
	});

	test("first-line heading — Left at visual start stays at visual start", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("first-line-heading.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await page.keyboard.press(`${modKey}+End`);
		const headingLine = page.locator(".cm-line.cm-heading-2");
		await expect(headingLine).toBeVisible({ timeout: 5000 });

		// Click heading, Home, then Left (no previous line to go to)
		await headingLine.click();
		await page.keyboard.press("Home");
		await page.keyboard.press("ArrowLeft");

		// Cursor should still be at visual start, not inside hidden prefix
		await page.keyboard.type("Y");
		await page.keyboard.press(`${modKey}+s`);
		await page.waitForTimeout(200);

		const calls = await mock.getCalls("write_file");
		const lastCall = calls[calls.length - 1];
		const content = lastCall.content as string;
		expect(content).toMatch(/^## Y/);
	});

	test("first-line blockquote — Home keeps cursor at visual start", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("first-line-blockquote.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await page.keyboard.press(`${modKey}+End`);
		const quoteLine = page.locator(".cm-line.cm-blockquote-line");
		await expect(quoteLine).toBeVisible({ timeout: 5000 });

		await quoteLine.click();
		await page.keyboard.press("Home");

		// Type — should appear after hidden "> "
		await page.keyboard.type("Z");
		await page.keyboard.press(`${modKey}+s`);
		await page.waitForTimeout(200);

		const calls = await mock.getCalls("write_file");
		const lastCall = calls[calls.length - 1];
		const content = lastCall.content as string;
		expect(content).toMatch(/^> Z/);
	});

	test("left arrow at heading start moves to previous line", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Move cursor away so heading decoration is active
		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		// Wait for the heading decoration
		const headingLine = page.locator(".cm-line.cm-heading-2");
		await expect(headingLine).toBeVisible({ timeout: 5000 });

		// Click on the heading and go to visual start
		await headingLine.click();
		await page.keyboard.press("Home");

		// Press Left — should jump to the previous line (the empty line before "## hello")
		await page.keyboard.press("ArrowLeft");

		// Type something to verify cursor is on the previous line
		await page.keyboard.type("X");

		// Save and check: "X" should appear on the line before "## hello"
		await page.keyboard.press(`${modKey}+s`);
		await page.waitForTimeout(200);

		const calls = await mock.getCalls("write_file");
		const lastCall = calls[calls.length - 1];
		const content = lastCall.content as string;

		// The "X" should be on the empty line before "## hello", making it "X\n## hello"
		expect(content).toContain("X\n## hello");
	});
});
