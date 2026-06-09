import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/links.md":
			"Hello world\n\nhttps://example.com\n\nCheck out https://example.com inline\n\nMore text",
	},
	directories: {
		"/workspace": [{ name: "links.md", path: "/workspace/links.md", isDirectory: false }],
	},
};

// 旧 Tauri 版は addFetchOgpMock で fetch_ogp を上書きして title/description を返していたが、
// Electron mock の fetchOgp は all-null OgpData を返す。link-cards.ts は ogp が null の
// 場合「loading 状態」として `.cm-link-card` 要素を即座にレンダリングするので、
// 可視性 / カウントの assert はこのデフォルト挙動でも成立する。

test.describe("link card preview", () => {
	test("カーソルが離れていると単独 URL がカード表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("links.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		await expect(page.locator(".cm-link-card").first()).toBeVisible({ timeout: 10000 });
	});

	test("インライン URL はカード化されない", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("links.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		await expect(page.locator(".cm-link-card").first()).toBeVisible({ timeout: 10000 });

		// 単独 URL のみ（インラインは含まれない）
		const cards = page.locator(".cm-link-card");
		await expect(cards).toHaveCount(1);
	});

	test("カーソルが URL 行に移動するとカードが解除される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("links.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		const card = page.locator(".cm-link-card").first();
		await expect(card).toBeVisible({ timeout: 10000 });

		// "https://example.com" 行（3 行目）にカーソル移動
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");

		await expect(card).not.toBeVisible({ timeout: 5000 });
	});
});
