import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/test.md": "# Hello",
	},
	directories: {
		"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
	},
};

/** ワークスペースをセットアップし、設定ダイアログを開いた状態を返す */
async function openSettingsDialog(page: Page): Promise<ElectronApiMock> {
	const mock = new ElectronApiMock(page);
	await mock.setup({ fs: workspace, dialogResult: "/workspace" });

	await page.goto("/");
	// workspace 未復元 (settings.workspacePath なし) なので NewTabContent が出る
	await expect(page.getByText("Verba volant, scripta manent.")).toBeVisible();

	await page.keyboard.press(`${modKey}+,`);
	await expect(page.getByText("設定")).toBeVisible();

	return mock;
}

test.describe("settings dialog", () => {
	test("Cmd+, で設定ダイアログが開く", async ({ page }) => {
		await openSettingsDialog(page);

		await expect(page.getByText("テーマ")).toBeVisible();
		await expect(page.getByText("行番号を表示")).toBeVisible();
	});

	test("Escape で設定ダイアログが閉じる", async ({ page }) => {
		await openSettingsDialog(page);

		await page.keyboard.press("Escape");
		await expect(page.getByText("設定")).not.toBeVisible();
	});

	test("テーマ設定を変更できる", async ({ page }) => {
		await openSettingsDialog(page);

		const themeSelect = page.locator("#theme-select");
		await expect(themeSelect).toHaveValue("system");

		await themeSelect.selectOption("dark");
		await expect(themeSelect).toHaveValue("dark");

		await themeSelect.selectOption("light");
		await expect(themeSelect).toHaveValue("light");
	});

	test("行番号表示をトグルできる", async ({ page }) => {
		await openSettingsDialog(page);

		const toggle = page.getByRole("switch", { name: "行番号を表示" });
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
	});

	test("セクションナビが表示されてセクションを切り替えられる", async ({ page }) => {
		await openSettingsDialog(page);

		const nav = page.locator('nav[aria-label="設定セクション"]');
		await expect(nav.getByText("外観")).toBeVisible();
		await expect(nav.getByText("エディタ")).toBeVisible();
		await expect(nav.getByText("保存")).toBeVisible();

		// 初期状態: 外観セクション
		await expect(page.getByText("テーマ")).toBeVisible();
		await expect(page.getByText("行番号を表示")).toBeVisible();
		await expect(page.getByText("アクティブ行をハイライト")).toBeVisible();

		// エディタセクション
		await nav.getByText("エディタ").click();
		await expect(page.getByText("フォントサイズ")).toBeVisible();
		await expect(page.getByText("フォント", { exact: true })).toBeVisible();
		await expect(page.getByText("テーマ")).not.toBeVisible();

		// 保存セクション
		await nav.getByText("保存").click();
		await expect(page.getByText("自動保存の遅延")).toBeVisible();
		await expect(page.getByText("行末の空白を削除")).toBeVisible();
		await expect(page.getByText("フォントサイズ")).not.toBeVisible();
	});

	test("アクティブ行ハイライトをトグルできる", async ({ page }) => {
		await openSettingsDialog(page);

		const toggle = page.getByRole("switch", { name: "アクティブ行をハイライト" });
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");
	});

	test("行末の空白削除をトグルできる", async ({ page }) => {
		await openSettingsDialog(page);

		await page.locator('nav[aria-label="設定セクション"]').getByText("保存").click();

		const toggle = page.getByRole("switch", { name: "行末の空白を削除" });
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "false");
	});

	test("このアプリについてセクションに Ko-fi ボタンが表示される", async ({ page }) => {
		await openSettingsDialog(page);

		const nav = page.locator('nav[aria-label="設定セクション"]');
		await nav.getByText("このアプリについて").click();

		await expect(page.getByText("scripta", { exact: true })).toBeVisible();
		await expect(
			page.getByText("ローカルファイルベースの軽量 Markdown メモアプリ。"),
		).toBeVisible();
		await expect(page.getByText("Ko-fi で応援する")).toBeVisible();
	});

	test("Ko-fi ボタンが openExternal を正しい URL で呼び出す", async ({ page }) => {
		const mock = await openSettingsDialog(page);

		const nav = page.locator('nav[aria-label="設定セクション"]');
		await nav.getByText("このアプリについて").click();

		await page.getByText("Ko-fi で応援する").click();

		const calls = await mock.getCalls("openExternal");
		expect(calls).toEqual([["https://ko-fi.com/yamanao"]]);
	});

	test("フォントファミリを変更できる", async ({ page }) => {
		await openSettingsDialog(page);

		await page.locator('nav[aria-label="設定セクション"]').getByText("エディタ").click();

		const fontSelect = page.locator("#font-family-select");
		await expect(fontSelect).toHaveValue("monospace");

		await fontSelect.selectOption("serif");
		await expect(fontSelect).toHaveValue("serif");
	});

	test("フォントファミリの変更がエディタの computed style に反映される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("test.md file").click();
		await expect(page.locator(".cm-content")).toBeVisible();

		const scroller = page.locator(".cm-scroller");
		const defaultFont = await scroller.evaluate((el) => window.getComputedStyle(el).fontFamily);
		expect(defaultFont).toContain("monospace");

		await page.keyboard.press(`${modKey}+,`);
		await page.locator('nav[aria-label="設定セクション"]').getByText("エディタ").click();
		await page.locator("#font-family-select").selectOption("serif");
		await page.keyboard.press("Escape");

		const serifFont = await scroller.evaluate((el) => window.getComputedStyle(el).fontFamily);
		expect(serifFont).toContain("Georgia");
	});

	test("セクション切り替え時にダイアログサイズが変動しない", async ({ page }) => {
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

	test("狭いビューポートでもダイアログを操作できる", async ({ page }) => {
		await page.setViewportSize({ width: 800, height: 500 });
		await openSettingsDialog(page);

		const dialog = page.locator("dialog");
		const box = await dialog.boundingBox();
		expect(box?.height).toBeLessThanOrEqual(500);

		const nav = page.locator('nav[aria-label="設定セクション"]');
		await nav.getByText("エディタ").click();
		await expect(page.getByText("フォントサイズ")).toBeVisible();

		await nav.getByText("保存").click();
		await expect(page.getByText("自動保存の遅延")).toBeVisible();
	});
});
