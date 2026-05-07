import { expect, test } from "@playwright/test";
import { ElectronApiMock } from "./helpers/electron-api-mock";

test.describe("help dialog", () => {
	test("F1 でヘルプダイアログが開く", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({});

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();
		await expect(page.getByText("太字")).toBeVisible();
		await expect(page.getByText("斜体")).toBeVisible();
		await expect(page.getByLabel("キーボードショートカット").getByText("保存")).toBeVisible();
	});

	test("Escape でヘルプダイアログが閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({});

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByText("キーボードショートカット")).not.toBeVisible();
	});

	test("バックドロップクリックで閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({});

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();

		const backdrop = page.getByTestId("dialog-backdrop");
		await backdrop.click({ position: { x: 5, y: 5 } });
		await expect(page.getByText("キーボードショートカット")).not.toBeVisible();
	});

	test("狭いビューポートでもダイアログがフィットしてスクロール可能", async ({ page }) => {
		await page.setViewportSize({ width: 800, height: 500 });
		const mock = new ElectronApiMock(page);
		await mock.setup({});

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();

		const dialog = page.locator("dialog");
		const box = await dialog.boundingBox();
		expect(box?.height).toBeLessThanOrEqual(500);

		// 先頭セクション（書式）と末尾セクション（表示）の両方が到達可能
		await expect(page.getByText("太字（エディタ内）")).toBeVisible();
		const lastItem = page.getByText("ヘルプ");
		await lastItem.scrollIntoViewIfNeeded();
		await expect(lastItem).toBeVisible();
	});
});
