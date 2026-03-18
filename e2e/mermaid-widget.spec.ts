import { type Page, expect, test } from "@playwright/test";
import { TauriMock, modKey } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/mermaid.md":
			"# Title\n\nSome text here.\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nMore text below.\n",
	},
	directories: {
		"/workspace": [{ name: "mermaid.md", path: "/workspace/mermaid.md", isDirectory: false }],
	},
};

async function openFileAndWaitForMermaid(page: Page) {
	const mock = new TauriMock(page);
	await mock.setup(workspace, "/workspace");
	await page.goto("/");
	await page.getByLabel("Open folder").click();
	await page.getByLabel("mermaid.md file").click();

	const editor = page.locator(".cm-content");
	await expect(editor).toBeVisible();

	// カーソルを1行目に移動（Mermaid ブロックから離す）
	await editor.click();
	await page.keyboard.press(`${modKey}+Home`);

	// Mermaid ウィジェットの SVG レンダリング完了を待機
	const widget = page.locator(".cm-mermaid-widget");
	await expect(widget).toBeVisible({ timeout: 15000 });
	await expect(widget.locator(".cm-mermaid-inner")).toBeVisible({ timeout: 15000 });

	return { editor, widget };
}

test.describe("mermaid widget", () => {
	test("left click does not collapse the widget", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		await widget.click();
		await page.waitForTimeout(500);

		await expect(widget).toBeVisible();
	});

	test("drag selection on widget stays stable", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		const box = await widget.boundingBox();
		if (!box) throw new Error("widget bounding box not found");

		await page.mouse.move(box.x + 5, box.y + 5);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5, {
			steps: 5,
		});
		await page.mouse.up();

		await expect(widget).toBeVisible();
	});

	test("right click shows mermaid context menu", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		await widget.click({ button: "right" });

		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Mermaid を編集" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Mermaid 図を挿入" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Mermaid を削除" })).toBeVisible();

		await expect(widget).toBeVisible();
	});

	test("edit dialog opens from context menu", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		await widget.click({ button: "right" });
		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();

		await menu.getByRole("menuitem", { name: "Mermaid を編集" }).click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText("Mermaid エディタ")).toBeVisible();
		await expect(dialog.locator('[aria-label="Mermaid ソースコード"]')).toContainText("graph TD");
		await expect(menu).not.toBeVisible();
	});

	test("cross-block drag selection from text through mermaid stays stable", async ({ page }) => {
		const { editor, widget } = await openFileAndWaitForMermaid(page);

		// カーソルを3行目（"Some text here."）の先頭に配置
		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");

		// 文書末尾まで選択を拡張（Mermaid ブロックを横断）
		await page.keyboard.press(`Shift+${modKey}+End`);
		await page.waitForTimeout(500);

		// collectCursorLines は anchor 行（3行目）のみを返すため、
		// Mermaid ブロック（5-7行目）のデコレーションは維持される
		await expect(widget).toBeVisible();
	});
});
