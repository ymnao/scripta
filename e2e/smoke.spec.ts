import { expect, test } from "@playwright/test";
import { ElectronApiMock } from "./helpers/electron-api-mock";

test.describe("smoke", () => {
	test("ワークスペース未選択で Open Folder ボタンが表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup();

		await page.goto("/");

		await expect(page.getByLabel("Open folder")).toBeVisible();
	});

	test("Open Folder ボタンを押すと openDirectoryPicker が呼ばれる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ dialogResult: null });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		const calls = await mock.getCalls("openDirectoryPicker");
		expect(calls.length).toBeGreaterThanOrEqual(1);
	});
});
