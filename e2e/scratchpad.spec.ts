import { expect, test } from "@playwright/test";
import { TauriMock, modKey } from "./helpers/tauri-mock";

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
	test("opens and closes scratchpad with Cmd+J", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", { workspacePath: "/workspace" });

		await page.goto("/");
		await expect(page.getByText("Select a file to start editing")).toBeVisible();

		// Open scratchpad
		await page.keyboard.press(`${modKey}+j`);
		await expect(page.getByTestId("scratchpad-panel")).toBeVisible();
		await expect(page.getByText("スクラッチパッド")).toBeVisible();

		// Close scratchpad
		await page.keyboard.press(`${modKey}+j`);
		await expect(page.getByTestId("scratchpad-panel")).not.toBeVisible();
	});

	test("closes scratchpad with close button", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", { workspacePath: "/workspace" });

		await page.goto("/");
		await expect(page.getByText("Select a file to start editing")).toBeVisible();

		await page.keyboard.press(`${modKey}+j`);
		await expect(page.getByTestId("scratchpad-panel")).toBeVisible();

		await page.getByLabel("スクラッチパッドを閉じる").click();
		await expect(page.getByTestId("scratchpad-panel")).not.toBeVisible();
	});

	test("toggles scratchpad from status bar button", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", { workspacePath: "/workspace" });

		await page.goto("/");
		await expect(page.getByText("Select a file to start editing")).toBeVisible();

		// Open via status bar
		await page.getByLabel("スクラッチパッド", { exact: true }).click();
		await expect(page.getByTestId("scratchpad-panel")).toBeVisible();

		// Close via status bar
		await page.getByLabel("スクラッチパッド", { exact: true }).click();
		await expect(page.getByTestId("scratchpad-panel")).not.toBeVisible();
	});

	test("settings dialog shows scratchpad section with volatile toggle", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", { workspacePath: "/workspace" });

		await page.goto("/");
		await expect(page.getByText("Select a file to start editing")).toBeVisible();

		await page.keyboard.press(`${modKey}+,`);
		await expect(page.getByText("設定")).toBeVisible();

		// Navigate to scratchpad section
		const nav = page.locator('nav[aria-label="設定セクション"]');
		await nav.getByText("スクラッチパッド").click();

		const toggle = page.getByRole("switch", { name: "日替わりでクリア" });
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false");
	});
});
