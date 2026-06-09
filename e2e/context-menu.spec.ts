import { expect, test } from "@playwright/test";
import { ElectronApiMock } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/test.md": "hello world",
	},
	directories: {
		"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
	},
};

async function openFile(page: import("@playwright/test").Page) {
	const mock = new ElectronApiMock(page);
	await mock.setup({ fs: workspace, dialogResult: "/workspace" });
	await page.goto("/");
	await page.getByLabel("フォルダを開く").click();
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
	test("選択なしのとき insert 系メニューが出る", async ({ page }) => {
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

	test("テキスト選択時は edit / format 系メニューが出る", async ({ page }) => {
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

	test("コンテキストメニューの太字で選択範囲を囲む", async ({ page }) => {
		const editor = await openFile(page);
		await editor.click();
		await selectText(page);

		await rightClickOnLine(page);
		await page.getByRole("menuitem", { name: "太字" }).click();

		await expect(editor).toContainText("**hello**");
	});

	test("コンテキストメニューから水平線が挿入される", async ({ page }) => {
		const editor = await openFile(page);
		await editor.click();

		await rightClickOnLine(page);
		await page.getByRole("menuitem", { name: "水平線を挿入" }).click();

		await expect(editor).toContainText("---");
	});

	test("コピーがクリップボードに反映される", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		const editor = await openFile(page);
		await editor.click();
		await selectText(page);

		await rightClickOnLine(page);
		await page.getByRole("menuitem", { name: "コピー" }).click();

		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("hello");
	});

	test("選択外右クリックで選択が解除されカーソルが移動する", async ({ page }) => {
		const editor = await openFile(page);
		await editor.click();
		await selectText(page);

		const line = page.locator(".cm-line").first();
		const box = await line.boundingBox();
		if (!box) throw new Error("line bounding box not found");
		// 行末付近を右クリック → 選択解除される
		await line.click({ button: "right", position: { x: box.width - 5, y: 5 } });

		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "テーブルを挿入" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "切り取り" })).toHaveCount(0);
	});

	test("切り取りがクリップボードに反映されてテキストが消える", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		const editor = await openFile(page);
		await editor.click();
		await selectText(page);

		await rightClickOnLine(page);
		await page.getByRole("menuitem", { name: "切り取り" }).click();

		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("hello");

		await expect(editor).not.toContainText("hello");
	});
});
