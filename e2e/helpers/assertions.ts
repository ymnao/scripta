import { expect, type Page } from "@playwright/test";

/** ステータスバーに「未保存」が表示されるまで待機する */
export async function waitForUnsaved(page: Page) {
	await expect(page.getByText("未保存")).toBeVisible();
}

/** ステータスバーに「保存済み」が表示されるまで待機する */
export async function waitForSaved(page: Page, timeout = 3000) {
	await expect(page.getByText("保存済み", { exact: true })).toBeVisible({ timeout });
}
