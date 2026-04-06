import { expect, test } from "@playwright/test";
import { TauriMock } from "./helpers/tauri-mock";

test.describe("help dialog", () => {
	test("opens help dialog with F1", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup({ files: {}, directories: {} }, null);

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();
		await expect(page.getByText("太字")).toBeVisible();
		await expect(page.getByText("斜体")).toBeVisible();
		await expect(page.getByLabel("キーボードショートカット").getByText("保存")).toBeVisible();
	});

	test("closes help dialog with Escape", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup({ files: {}, directories: {} }, null);

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByText("キーボードショートカット")).not.toBeVisible();
	});

	test("closes help dialog by clicking backdrop", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup({ files: {}, directories: {} }, null);

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();

		// Click the backdrop (outside the dialog)
		const backdrop = page.getByTestId("dialog-backdrop");
		await backdrop.click({ position: { x: 5, y: 5 } });
		await expect(page.getByText("キーボードショートカット")).not.toBeVisible();
	});

	test("dialog fits and scrolls at small viewport", async ({ page }) => {
		await page.setViewportSize({ width: 800, height: 500 });
		const mock = new TauriMock(page);
		await mock.setup({ files: {}, directories: {} }, null);

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();

		const dialog = page.locator("dialog");
		const box = await dialog.boundingBox();
		// ダイアログがビューポートに収まること
		expect(box?.height).toBeLessThanOrEqual(500);

		// 先頭セクション（書式）と末尾セクション（表示）の両方が到達可能
		await expect(page.getByText("太字（エディタ内）")).toBeVisible();
		const lastItem = page.getByText("ヘルプ");
		await lastItem.scrollIntoViewIfNeeded();
		await expect(lastItem).toBeVisible();
	});
});
