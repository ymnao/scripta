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

async function openTableFile(page: Page, content = tableContent): Promise<Locator> {
	await openSingleFileWorkspace(page, {
		files: { "/workspace/table.md": content },
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
		await openTableFile(page, bofTableContent);

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

	test("BOF gap への貼り付けで本文とカーソルが正しく入る (#167)", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await openTableFile(page, bofTableContent);

		// クリップボードに貼り付け対象を仕込む
		await page.evaluate(() => navigator.clipboard.writeText("pasted"));

		// 本文にカーソルを置いてから文書先頭（BOF gap）へ移動
		await page.getByText("after text").click();
		await page.keyboard.press(`${modKey}+Home`);
		await expect(page.locator(".cm-table-gap-cursor")).toBeVisible();

		// Cmd+V（CM native paste）で貼り付ける。native paste は userEvent: "input.paste" を
		// 付けて selection 付き dispatch を発行するため tableGapMaterialize の selection
		// マップ経路に乗り、`pasted\n` が入りカーソルは `pasted` 直後へ進む。
		// （右クリック経路は handleEditorContextMenu が clickPos へカーソルを移動させ BOF
		//  gap を外すため、gap での貼り付け検証は Cmd+V 経路で行う。）
		await page.keyboard.press(`${modKey}+v`);

		// 続けて入力した X が貼り付けテキストと同じ行に続く（カーソルが直後に進んだ証拠）
		await page.keyboard.type("X");
		await expect(page.locator(".cm-line").first()).toHaveText("pastedX");
	});

	test("セル編集中は gap cursor が消える (#167)", async ({ page }) => {
		// 文書先頭がテーブルのとき、セル編集中も anchorEditorToTable が CM selection を
		// BOF gap に置くため、以前はセル編集中ずっと gap cursor バーが出ていた。
		await openTableFile(page, bofTableContent);

		// データ行のセルをクリックして編集に入る
		await page.locator('[data-row="1"][data-col="0"]').click();
		await expect.poll(() => isCellFocused(page)).toBe(true);

		// セル編集中は gap cursor バーが描かれない
		await expect(page.locator(".cm-table-gap-cursor")).toHaveCount(0);

		// セル内で ArrowUp を 2 回押して最上行 → BOF gap へ抜ける
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");

		// セルからフォーカスが外れ BOF gap に来たので gap cursor バーが 1 個復活する
		await expect.poll(() => isCellFocused(page)).toBe(false);
		await expect(page.locator(".cm-table-gap-cursor")).toHaveCount(1);
		await expect(page.locator(".cm-table-gap-cursor")).toBeVisible();
	});

	test("EOF gap: 文書末尾への移動で文書を変えず、入力で行が生える (#167)", async ({ page }) => {
		await openTableFile(page, eofTableContent);

		await page.getByText("before text").click();
		await page.keyboard.press(`${modKey}+End`);

		await expect(page.locator(".cm-table-gap-cursor")).toBeVisible();
		await expect(page.getByText("未保存")).toHaveCount(0);

		await page.keyboard.type("world");
		await expect(page.locator(".cm-line").last()).toHaveText("world");
	});
});
