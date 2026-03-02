import { expect, test } from "@playwright/test";
import { TauriMock, modKey } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/test.md": "# Hello",
	},
	directories: {
		"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
	},
};

test.describe("settings dialog", () => {
	test("opens settings dialog with Cmd+,", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press(`${modKey}+,`);
		await expect(page.getByText("設定")).toBeVisible();
		await expect(page.getByText("テーマ")).toBeVisible();
		await expect(page.getByText("行番号を表示")).toBeVisible();
	});

	test("closes settings dialog with Escape", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press(`${modKey}+,`);
		await expect(page.getByText("設定")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByText("設定")).not.toBeVisible();
	});

	test("can change theme preference", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press(`${modKey}+,`);
		await expect(page.getByText("設定")).toBeVisible();

		const themeSelect = page.locator("#theme-select");
		await expect(themeSelect).toHaveValue("system");

		await themeSelect.selectOption("dark");
		await expect(themeSelect).toHaveValue("dark");

		await themeSelect.selectOption("light");
		await expect(themeSelect).toHaveValue("light");
	});

	test("can toggle line numbers", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press(`${modKey}+,`);
		await expect(page.getByText("設定")).toBeVisible();

		const toggle = page.getByRole("switch", { name: "行番号を表示" });
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
	});

	test("shows section navigation and switches content", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press(`${modKey}+,`);
		await expect(page.getByText("設定")).toBeVisible();

		// 左ナビにセクションが表示される
		const nav = page.locator('nav[aria-label="設定セクション"]');
		await expect(nav.getByText("外観")).toBeVisible();
		await expect(nav.getByText("エディタ")).toBeVisible();
		await expect(nav.getByText("保存")).toBeVisible();

		// 初期状態: 外観セクションが表示
		await expect(page.getByText("テーマ")).toBeVisible();
		await expect(page.getByText("行番号を表示")).toBeVisible();
		await expect(page.getByText("アクティブ行をハイライト")).toBeVisible();

		// エディタセクションに切り替え
		await nav.getByText("エディタ").click();
		await expect(page.getByText("フォントサイズ")).toBeVisible();
		await expect(page.getByText("フォント", { exact: true })).toBeVisible();
		// 外観の項目は非表示
		await expect(page.getByText("テーマ")).not.toBeVisible();

		// 保存セクションに切り替え
		await nav.getByText("保存").click();
		await expect(page.getByText("自動保存の遅延")).toBeVisible();
		await expect(page.getByText("行末の空白を削除")).toBeVisible();
		// エディタの項目は非表示
		await expect(page.getByText("フォントサイズ")).not.toBeVisible();
	});

	test("can toggle highlight active line", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press(`${modKey}+,`);

		const toggle = page.getByRole("switch", { name: "アクティブ行をハイライト" });
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
	});

	test("can toggle trim trailing whitespace", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press(`${modKey}+,`);

		// 保存セクションに切り替え
		await page.locator('nav[aria-label="設定セクション"]').getByText("保存").click();

		const toggle = page.getByRole("switch", { name: "行末の空白を削除" });
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false");
	});

	test("can change font family", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

		await page.keyboard.press(`${modKey}+,`);

		// エディタセクションに切り替え
		await page.locator('nav[aria-label="設定セクション"]').getByText("エディタ").click();

		const fontSelect = page.locator("#font-family-select");
		await expect(fontSelect).toHaveValue("monospace");

		await fontSelect.selectOption("serif");
		await expect(fontSelect).toHaveValue("serif");
	});
});
