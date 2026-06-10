import { expect, type Locator, type Page, test } from "@playwright/test";
import { modKey } from "./helpers/electron-api-mock";
import { openSingleFileWorkspace } from "./helpers/workspace-setup";

const tableContent = `# Table test

| A | B |
| --- | --- |
| 1 | 2 |

after text
`;

// テーブルで始まる文書（先頭境界が BOF gap になる）
const bofTableContent = `| A | B |
| --- | --- |
| 1 | 2 |

after text
`;

// テーブルで終わる文書（末尾境界が EOF gap になる）
const eofTableContent = `before text

| A | B |
| --- | --- |
| 1 | 2 |`;

async function openTableFile(page: Page): Promise<Locator> {
	await openSingleFileWorkspace(page, {
		files: { "/workspace/table.md": tableContent },
	});
	const widget = page.locator(".cm-table-widget");
	await expect(widget).toBeVisible();
	return widget;
}

/** テーブル右側の余白（widget 内・table 要素の外）をクリックし、widget の矩形を返す */
async function clickTableRightMargin(
	page: Page,
	widget: Locator,
): Promise<{ width: number; height: number }> {
	const box = await widget.boundingBox();
	if (!box) throw new Error("widget bounding box not found");
	await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
	return box;
}

function isCellFocused(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const el = document.activeElement;
		return el?.tagName === "TD" || el?.tagName === "TH";
	});
}

test.describe("table widget", () => {
	test("テーブル右余白クリックで巨大キャレットにならず隣接行にカーソルが置かれる (#146)", async ({
		page,
	}) => {
		const widget = await openTableFile(page);
		const widgetBox = await clickTableRightMargin(page, widget);

		// クリックはエディタに委譲され、カーソルが置かれる（デッドゾーンにならない）
		const cursor = page.locator(".cm-cursor-primary");
		await expect(cursor).toBeVisible();

		// キャレットは通常の行高（widget 全高の巨大キャレットでない）
		const cursorBox = await cursor.boundingBox();
		if (!cursorBox) throw new Error("cursor bounding box not found");
		expect(cursorBox.height).toBeLessThan(widgetBox.height / 2);

		// tableCursorFilter の退避は selection のみで、ドキュメントは改変されない
		await expect(widget).toBeVisible();
		await expect(page.locator(".cm-content")).toContainText("after text");
	});

	test("テーブル右余白クリックでフォーカス中のセルが blur される (#146)", async ({ page }) => {
		const widget = await openTableFile(page);

		await widget.locator('[data-row="1"][data-col="0"]').click();
		await expect.poll(() => isCellFocused(page)).toBe(true);

		await clickTableRightMargin(page, widget);
		await expect.poll(() => isCellFocused(page)).toBe(false);
	});

	test("BOF gap: 文書先頭への移動で文書を変えず gap cursor が表示される (#167)", async ({
		page,
	}) => {
		await openSingleFileWorkspace(page, {
			files: { "/workspace/bof-table.md": bofTableContent },
		});
		await expect(page.locator(".cm-table-widget")).toBeVisible();

		// 本文にカーソルを置いてから文書先頭（BOF gap）へ移動
		await page.getByText("after text").click();
		await page.keyboard.press(`${modKey}+Home`);

		// gap cursor バーが表示され、widget 全高の巨大キャレット（primary cursor）は隠れる
		await expect(page.locator(".cm-table-gap-cursor")).toBeVisible();
		await expect(page.locator(".cm-editor.cm-table-gap-active")).toHaveCount(1);
		await expect(page.locator(".cm-cursorLayer .cm-cursor-primary")).toBeHidden();

		// selection を置いただけでは文書は変わらない（dirty にならない）
		await expect(page.getByText("未保存")).toHaveCount(0);

		// 入力すると materialize されてテーブルの前に行ができる
		await page.keyboard.type("hello");
		await expect(page.locator(".cm-line").first()).toHaveText("hello");
	});

	test("EOF gap: 文書末尾への移動で文書を変えず、入力で行が生える (#167)", async ({ page }) => {
		await openSingleFileWorkspace(page, {
			files: { "/workspace/eof-table.md": eofTableContent },
		});
		await expect(page.locator(".cm-table-widget")).toBeVisible();

		await page.getByText("before text").click();
		await page.keyboard.press(`${modKey}+End`);

		await expect(page.locator(".cm-table-gap-cursor")).toBeVisible();
		await expect(page.getByText("未保存")).toHaveCount(0);

		await page.keyboard.type("world");
		await expect(page.locator(".cm-line").last()).toHaveText("world");
	});
});
