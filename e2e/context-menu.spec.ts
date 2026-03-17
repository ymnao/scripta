import { expect, test } from "@playwright/test";
import { TauriMock } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/test.md": "hello world",
	},
	directories: {
		"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
	},
};

async function openFile(page: import("@playwright/test").Page) {
	const mock = new TauriMock(page);
	await mock.setup(workspace, "/workspace");
	await page.goto("/");
	await page.getByLabel("Open folder").click();
	await page.getByLabel("test.md file").click();
	const editor = page.locator(".cm-content");
	await expect(editor).toBeVisible();
	return editor;
}

async function selectText(page: import("@playwright/test").Page) {
	await page.keyboard.press("Home");
	for (let i = 0; i < 5; i++) {
		await page.keyboard.press("Shift+ArrowRight");
	}
}

/** Right-click on the first line of the editor (where the text is) */
async function rightClickOnLine(page: import("@playwright/test").Page) {
	const line = page.locator(".cm-line").first();
	await line.click({ button: "right", position: { x: 10, y: 5 } });
}

test.describe("editor context menu", () => {
	test("shows insert items when no text is selected", async ({ page }) => {
		const editor = await openFile(page);
		await editor.click();

		await rightClickOnLine(page);

		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "貼り付け" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "テーブルを挿入" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "水平線を挿入" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "切り取り" })).toHaveCount(0);
	});

	test("shows edit/format items when text is selected", async ({ page }) => {
		const editor = await openFile(page);
		await editor.click();
		await selectText(page);

		await rightClickOnLine(page);

		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "切り取り" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "コピー" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "太字" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "テーブルを挿入" })).toHaveCount(0);
	});

	test("bold via context menu wraps selection", async ({ page }) => {
		const editor = await openFile(page);
		await editor.click();
		await selectText(page);

		await rightClickOnLine(page);
		await page.getByRole("menuitem", { name: "太字" }).click();

		await expect(editor).toContainText("**hello**");
	});

	test("horizontal rule inserts --- via context menu", async ({ page }) => {
		const editor = await openFile(page);
		await editor.click();

		await rightClickOnLine(page);
		await page.getByRole("menuitem", { name: "水平線を挿入" }).click();

		await expect(editor).toContainText("---");
	});

	test("copy via context menu copies to clipboard", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		const editor = await openFile(page);
		await editor.click();
		await selectText(page);

		await rightClickOnLine(page);
		await page.getByRole("menuitem", { name: "コピー" }).click();

		// Wait for async clipboard write to complete
		await page.waitForTimeout(100);
		const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboardText).toBe("hello");
	});

	test("right-click outside selection clears selection and moves cursor", async ({ page }) => {
		const editor = await openFile(page);
		await editor.click();
		// Select "hello" at the beginning
		await selectText(page);

		// Right-click far from selection (end of line) — should deselect
		const line = page.locator(".cm-line").first();
		const box = await line.boundingBox();
		if (!box) throw new Error("line bounding box not found");
		// Click near the right end of the line
		await line.click({ button: "right", position: { x: box.width - 5, y: 5 } });

		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();
		// Should show no-selection menu (insert items, no cut/copy)
		await expect(menu.getByRole("menuitem", { name: "テーブルを挿入" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "切り取り" })).toHaveCount(0);
	});

	test("cut via context menu copies and removes text", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		const editor = await openFile(page);
		await editor.click();
		await selectText(page);

		await rightClickOnLine(page);
		await page.getByRole("menuitem", { name: "切り取り" }).click();

		// Wait for async clipboard write + DOM update
		await page.waitForTimeout(100);
		const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboardText).toBe("hello");

		await expect(editor).not.toContainText("hello");
	});
});
