import { expect, test } from "@playwright/test";
import { TauriMock } from "./helpers/tauri-mock";

test.describe("help dialog", () => {
	test("opens help dialog with F1", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup({ files: {}, directories: {} }, null);

		await page.goto("/");
		await expect(page.getByText("Select a file to start editing")).toBeVisible();

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();
		await expect(page.getByText("太字")).toBeVisible();
		await expect(page.getByText("斜体")).toBeVisible();
		await expect(page.getByText("保存")).toBeVisible();
	});

	test("closes help dialog with Escape", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup({ files: {}, directories: {} }, null);

		await page.goto("/");
		await expect(page.getByText("Select a file to start editing")).toBeVisible();

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByText("キーボードショートカット")).not.toBeVisible();
	});

	test("closes help dialog by clicking backdrop", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup({ files: {}, directories: {} }, null);

		await page.goto("/");
		await expect(page.getByText("Select a file to start editing")).toBeVisible();

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();

		// Click the backdrop (outside the dialog)
		const backdrop = page.locator('[role="presentation"]');
		await backdrop.click({ position: { x: 5, y: 5 } });
		await expect(page.getByText("キーボードショートカット")).not.toBeVisible();
	});
});
