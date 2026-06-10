import { expect, type Locator, type Page, test } from "@playwright/test";
import { openSingleFileWorkspace } from "./helpers/workspace-setup";

const tableContent = `# Table test

| A | B |
| --- | --- |
| 1 | 2 |

after text
`;

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
});
