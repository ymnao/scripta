import type { Page } from "@playwright/test";
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

/** ワークスペースをセットアップし、設定ダイアログを開いた状態を返す */
async function openSettingsDialog(page: Page): Promise<TauriMock> {
	const mock = new TauriMock(page);
	await mock.setup(workspace, "/workspace");

	await page.goto("/");
	await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

	await page.keyboard.press(`${modKey}+,`);
	await expect(page.getByText("設定")).toBeVisible();

	return mock;
}

test.describe("settings dialog", () => {
	test("opens settings dialog with Cmd+,", async ({ page }) => {
		await openSettingsDialog(page);

		await expect(page.getByText("テーマ")).toBeVisible();
		await expect(page.getByText("行番号を表示")).toBeVisible();
	});

	test("closes settings dialog with Escape", async ({ page }) => {
		await openSettingsDialog(page);

		await page.keyboard.press("Escape");
		await expect(page.getByText("設定")).not.toBeVisible();
	});

	test("can change theme preference", async ({ page }) => {
		await openSettingsDialog(page);

		const themeSelect = page.locator("#theme-select");
		await expect(themeSelect).toHaveValue("system");

		await themeSelect.selectOption("dark");
		await expect(themeSelect).toHaveValue("dark");

		await themeSelect.selectOption("light");
		await expect(themeSelect).toHaveValue("light");
	});

	test("can toggle line numbers", async ({ page }) => {
		await openSettingsDialog(page);

		const toggle = page.getByRole("switch", { name: "行番号を表示" });
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
	});

	test("shows section navigation and switches content", async ({ page }) => {
		await openSettingsDialog(page);

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
		await openSettingsDialog(page);

		const toggle = page.getByRole("switch", { name: "アクティブ行をハイライト" });
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
	});

	test("can toggle trim trailing whitespace", async ({ page }) => {
		await openSettingsDialog(page);

		// 保存セクションに切り替え
		await page.locator('nav[aria-label="設定セクション"]').getByText("保存").click();

		const toggle = page.getByRole("switch", { name: "行末の空白を削除" });
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false");
	});

	test("shows about section with Ko-fi button", async ({ page }) => {
		await openSettingsDialog(page);

		const nav = page.locator('nav[aria-label="設定セクション"]');
		await nav.getByText("このアプリについて").click();

		await expect(page.getByText("scripta", { exact: true })).toBeVisible();
		await expect(
			page.getByText("ローカルファイルベースの軽量 Markdown メモアプリ。"),
		).toBeVisible();
		await expect(page.getByText("Ko-fi で応援する")).toBeVisible();
	});

	test("Ko-fi button calls shell:open with correct URL", async ({ page }) => {
		const mock = await openSettingsDialog(page);

		const nav = page.locator('nav[aria-label="設定セクション"]');
		await nav.getByText("このアプリについて").click();

		await page.getByText("Ko-fi で応援する").click();

		const calls = await mock.getCalls("shell:open");
		expect(calls).toEqual([{ url: "https://ko-fi.com/yamanao" }]);
	});

	test("can change font family", async ({ page }) => {
		await openSettingsDialog(page);

		// エディタセクションに切り替え
		await page.locator('nav[aria-label="設定セクション"]').getByText("エディタ").click();

		const fontSelect = page.locator("#font-family-select");
		await expect(fontSelect).toHaveValue("monospace");

		await fontSelect.selectOption("serif");
		await expect(fontSelect).toHaveValue("serif");
	});

	test("dialog size stays stable when switching sections", async ({ page }) => {
		await openSettingsDialog(page);

		const dialog = page.locator("dialog");
		const initialBox = await dialog.boundingBox();

		const nav = page.locator('nav[aria-label="設定セクション"]');
		const sections = ["エディタ", "保存", "スクラッチパッド", "外観"];
		for (const section of sections) {
			await nav.getByText(section).click();
			const box = await dialog.boundingBox();
			expect(Math.abs((box?.height ?? 0) - (initialBox?.height ?? 0))).toBeLessThanOrEqual(1);
			expect(Math.abs((box?.width ?? 0) - (initialBox?.width ?? 0))).toBeLessThanOrEqual(1);
		}
	});

	test("dialog is usable at small viewport", async ({ page }) => {
		await page.setViewportSize({ width: 800, height: 500 });
		await openSettingsDialog(page);

		const dialog = page.locator("dialog");
		const box = await dialog.boundingBox();
		// ダイアログがビューポートに収まること
		expect(box?.height).toBeLessThanOrEqual(500);

		// セクション切り替えが操作可能であること
		const nav = page.locator('nav[aria-label="設定セクション"]');
		await nav.getByText("エディタ").click();
		await expect(page.getByText("フォントサイズ")).toBeVisible();

		await nav.getByText("保存").click();
		await expect(page.getByText("自動保存の遅延")).toBeVisible();
	});
});
