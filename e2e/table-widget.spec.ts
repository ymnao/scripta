import { expect, test } from "@playwright/test";
import { ElectronApiMock } from "./helpers/electron-api-mock";

const tableContent = `# Table test

| A | B |
| --- | --- |
| 1 | 2 |

after text
`;

const workspace = {
	files: {
		"/workspace/table.md": tableContent,
		"/workspace/.scripta/initialized.json": '{"initializedAt":"2026-01-01T00:00:00.000Z"}',
	},
	directories: {
		"/workspace": [{ name: "table.md", path: "/workspace/table.md", isDirectory: false }],
	},
};

async function openTableFile(page: import("@playwright/test").Page): Promise<void> {
	const mock = new ElectronApiMock(page);
	await mock.setup({ fs: workspace, dialogResult: "/workspace" });

	await page.goto("/");
	await page.getByLabel("フォルダを開く").click();
	await page.getByLabel("table.md file").click();

	await expect(page.locator(".cm-table-widget")).toBeVisible();
}

test.describe("table widget", () => {
	test("テーブル右余白クリックで巨大キャレットが描画されない (#146)", async ({ page }) => {
		await openTableFile(page);

		const widget = page.locator(".cm-table-widget");
		const widgetBox = await widget.boundingBox();
		expect(widgetBox).not.toBeNull();
		if (!widgetBox) return;

		// テーブル右側の余白（widget 内・table 要素の外）をクリック
		await page.mouse.click(widgetBox.x + widgetBox.width - 8, widgetBox.y + widgetBox.height / 2);

		// 表示中のキャレットがあれば通常の行高であること（widget 全高の巨大キャレットでない）
		const cursors = page.locator(".cm-cursor");
		const count = await cursors.count();
		for (let i = 0; i < count; i++) {
			const box = await cursors.nth(i).boundingBox();
			if (box) {
				expect(box.height).toBeLessThan(widgetBox.height / 2);
			}
		}

		// クリックはウィジェット側で消費され、ドキュメントは改変されない
		await expect(page.locator(".cm-table-widget")).toBeVisible();
		await expect(page.locator(".cm-content")).toContainText("after text");
	});

	test("テーブル右余白クリックでフォーカス中のセルが blur される (#146)", async ({ page }) => {
		await openTableFile(page);

		const widget = page.locator(".cm-table-widget");
		const cell = widget.locator('[data-row="1"][data-col="0"]');
		await cell.click();
		await expect
			.poll(() =>
				page.evaluate(() => {
					const el = document.activeElement;
					return el?.tagName === "TD" || el?.tagName === "TH";
				}),
			)
			.toBe(true);

		const widgetBox = await widget.boundingBox();
		expect(widgetBox).not.toBeNull();
		if (!widgetBox) return;

		await page.mouse.click(widgetBox.x + widgetBox.width - 8, widgetBox.y + widgetBox.height / 2);

		await expect
			.poll(() =>
				page.evaluate(() => {
					const el = document.activeElement;
					return el?.tagName === "TD" || el?.tagName === "TH";
				}),
			)
			.toBe(false);
	});
});
