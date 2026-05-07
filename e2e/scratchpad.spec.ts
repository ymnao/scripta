import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/test.md": "# Hello",
		"/workspace/.scripta/initialized.json": '{"initializedAt":"2026-01-01T00:00:00.000Z"}',
		"/workspace/.scripta/scratchpad.md": "",
	},
	directories: {
		"/workspace": [
			{ name: "test.md", path: "/workspace/test.md", isDirectory: false },
			{ name: ".scripta", path: "/workspace/.scripta", isDirectory: true },
		],
		"/workspace/.scripta": [
			{
				name: "initialized.json",
				path: "/workspace/.scripta/initialized.json",
				isDirectory: false,
			},
			{ name: "scratchpad.md", path: "/workspace/.scripta/scratchpad.md", isDirectory: false },
		],
	},
};

test.describe("scratchpad", () => {
	test("Cmd+J でスクラッチパッドが開閉する", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			settings: { workspacePath: "/workspace" },
		});

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press(`${modKey}+j`);
		await expect(page.getByTestId("scratchpad-panel")).toBeVisible();
		await expect(page.getByText("スクラッチパッド")).toBeVisible();

		await page.keyboard.press(`${modKey}+j`);
		await expect(page.getByTestId("scratchpad-panel")).not.toBeVisible();
	});

	test("閉じるボタンでスクラッチパッドが閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			settings: { workspacePath: "/workspace" },
		});

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press(`${modKey}+j`);
		await expect(page.getByTestId("scratchpad-panel")).toBeVisible();

		await page.getByLabel("スクラッチパッドを閉じる").click();
		await expect(page.getByTestId("scratchpad-panel")).not.toBeVisible();
	});

	test("ステータスバーボタンでスクラッチパッドをトグルできる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			settings: { workspacePath: "/workspace" },
		});

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.getByLabel("スクラッチパッド", { exact: true }).click();
		await expect(page.getByTestId("scratchpad-panel")).toBeVisible();

		await page.getByLabel("スクラッチパッド", { exact: true }).click();
		await expect(page.getByTestId("scratchpad-panel")).not.toBeVisible();
	});

	test("設定ダイアログにスクラッチパッドのトグルが表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			settings: { workspacePath: "/workspace" },
		});

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press(`${modKey}+,`);
		await expect(page.getByText("設定")).toBeVisible();

		const nav = page.locator('nav[aria-label="設定セクション"]');
		await nav.getByText("スクラッチパッド").click();

		const toggle = page.getByRole("switch", { name: "日替わりでクリア" });
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false");
	});
});
