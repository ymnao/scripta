import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

/**
 * md link widget (`[label](<url>)` の青リンク表示) と OGP card 右クリックメニュー
 * の実 DOM イベント順序を Playwright で検証する。unit / pure helper では捕まら
 * ない cmd+click → openExternal の dispatch order、ContextMenu の表示 / 操作、
 * Dialog 経由の変換などをカバーする。
 *
 * renderer-only モード:
 * - window.api は ElectronApiMock で注入される
 * - fetchOgp は all-null OgpData を返す → link-cards.ts は loading 状態の
 *   `.cm-link-card` を即時 render するのでカード関連 assert は成立する
 * - openExternal の呼び出しは mock.getCalls("openExternal") で検証
 */

const URL_EXAMPLE = "https://example.com";
const URL_OTHER = "https://other.test";
const URL_CARD = "https://standalone.test";

const workspace = {
	files: {
		"/workspace/links.md": [
			"intro line",
			"",
			`[Example](<${URL_EXAMPLE}>)`, // URL-only line, label != URL
			"",
			`prefix [Other](<${URL_OTHER}>) suffix`, // mixed-line (suppress "カードにする")
			"",
			URL_CARD, // standalone → OGP card
			"",
			"end",
		].join("\n"),
	},
	directories: {
		"/workspace": [{ name: "links.md", path: "/workspace/links.md", isDirectory: false }],
	},
};

async function setupLinksFile(page: Page): Promise<ElectronApiMock> {
	const mock = new ElectronApiMock(page);
	await mock.setup({ fs: workspace, dialogResult: "/workspace" });
	await page.goto("/");
	await page.getByLabel("Open folder").click();
	await page.getByLabel("links.md file").click();
	const editor = page.locator(".cm-content");
	await expect(editor).toBeVisible();
	await editor.click();
	// カーソルを先頭に: link widget / card が render される位置から離す
	await page.keyboard.press(`${modKey}+Home`);
	// widget が render されるまで待つ
	await expect(page.locator(".cm-link-widget").first()).toBeVisible({ timeout: 10000 });
	return mock;
}

test.describe("md link widget — cmd/ctrl+click で URL を開く", () => {
	test("modifier+click が openExternal を呼ぶ", async ({ page }) => {
		const mock = await setupLinksFile(page);
		await mock.clearCalls("openExternal");

		const widget = page.locator(".cm-link-widget").first();
		await widget.click({ modifiers: [modKey === "Meta" ? "Meta" : "Control"] });

		const calls = await mock.getCalls("openExternal");
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0][0]).toBe(URL_EXAMPLE);
	});

	test("plain click は openExternal を呼ばずカーソル移動だけする", async ({ page }) => {
		const mock = await setupLinksFile(page);
		await mock.clearCalls("openExternal");

		// 「Example」widget をクリック → cursor が link 行に入り cursorInRange で
		// 該当 widget が消える（残った widget は混在 line の "Other" 側 1 つだけ）
		await page.locator(".cm-link-widget", { hasText: "Example" }).click();

		await expect(page.locator(".cm-link-widget")).toHaveCount(1, { timeout: 3000 });
		await expect(page.locator(".cm-link-widget", { hasText: "Other" })).toBeVisible();
		const calls = await mock.getCalls("openExternal");
		expect(calls.length).toBe(0);
	});
});

test.describe("md link widget — 右クリックメニュー", () => {
	test("URL only line でメニューに「リンクを開く」「URL をコピー」「カードにする」が出る", async ({
		page,
	}) => {
		await setupLinksFile(page);

		const widget = page.locator(".cm-link-widget").first();
		await widget.click({ button: "right" });

		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "リンクを開く" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "URL をコピー" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "カードにする" })).toBeVisible();
	});

	test("混在 line では「カードにする」が出ない", async ({ page }) => {
		await setupLinksFile(page);

		const widgets = page.locator(".cm-link-widget");
		await expect(widgets).toHaveCount(2);
		// 2 つめが mixed-line ("prefix [Other](<...>) suffix")
		await widgets.nth(1).click({ button: "right" });

		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "リンクを開く" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "カードにする" })).toHaveCount(0);
	});

	test("「リンクを開く」メニュー click で openExternal が呼ばれる", async ({ page }) => {
		const mock = await setupLinksFile(page);
		await mock.clearCalls("openExternal");

		const widget = page.locator(".cm-link-widget").first();
		await widget.click({ button: "right" });
		await page.getByRole("menuitem", { name: "リンクを開く" }).click();

		const calls = await mock.getCalls("openExternal");
		expect(calls[0][0]).toBe(URL_EXAMPLE);
	});

	test("「URL をコピー」が clipboard に URL を書き込む", async ({ page, context }) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await setupLinksFile(page);

		const widget = page.locator(".cm-link-widget").first();
		await widget.click({ button: "right" });
		await page.getByRole("menuitem", { name: "URL をコピー" }).click();

		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(URL_EXAMPLE);
	});

	test("「カードにする」(label != URL) で確認 Dialog を経由して変換される", async ({ page }) => {
		await setupLinksFile(page);

		// 初期状態: card は standalone URL 行の 1 枚だけ
		await expect(page.locator(".cm-link-card")).toHaveCount(1);

		await page.locator(".cm-link-widget", { hasText: "Example" }).click({ button: "right" });
		await page.getByRole("menuitem", { name: "カードにする" }).click();

		// label "Example" は URL と一致しないので確認 Dialog が出る
		await expect(page.getByRole("dialog")).toBeVisible();
		await expect(page.getByText(/Example.*URL と異なります/)).toBeVisible();
		await page.getByRole("button", { name: "変換する" }).click();

		// 変換後: 元の「Example」widget が消え、その行が plain URL になり OGP card 化
		await expect(page.locator(".cm-link-widget", { hasText: /^Example$/ })).toHaveCount(0, {
			timeout: 3000,
		});
		await expect(page.locator(".cm-link-card")).toHaveCount(2);
	});

	test("「カードにする」確認 Dialog を「キャンセル」すると元のまま", async ({ page }) => {
		await setupLinksFile(page);

		await page.locator(".cm-link-widget", { hasText: "Example" }).click({ button: "right" });
		await page.getByRole("menuitem", { name: "カードにする" }).click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.getByRole("button", { name: "キャンセル" }).click();

		// Dialog 閉じる + 元の「Example」widget は残る
		await expect(page.getByRole("dialog")).not.toBeVisible();
		await expect(page.locator(".cm-link-widget", { hasText: /^Example$/ })).toBeVisible();
		// URL ラベル widget は出現しない
		await expect(page.locator(".cm-link-widget", { hasText: URL_EXAMPLE })).toHaveCount(0);
	});
});

test.describe("OGP card — 右クリックメニュー", () => {
	test("カード上の右クリックで 4 項目メニューが出る", async ({ page }) => {
		await setupLinksFile(page);

		const card = page.locator(".cm-link-card").first();
		await expect(card).toBeVisible();
		await card.click({ button: "right" });

		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "リンクを開く" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "URL をコピー" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "md リンクに変換" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "カードを削除" })).toBeVisible();
	});

	test("「リンクを開く」が openExternal を呼ぶ", async ({ page }) => {
		const mock = await setupLinksFile(page);
		await mock.clearCalls("openExternal");

		const card = page.locator(".cm-link-card").first();
		await card.click({ button: "right" });
		await page.getByRole("menuitem", { name: "リンクを開く" }).click();

		const calls = await mock.getCalls("openExternal");
		expect(calls[0][0]).toBe(URL_CARD);
	});

	test("「md リンクに変換」で `[url](<url>)` に置き換わりカードが消える", async ({ page }) => {
		await setupLinksFile(page);

		const card = page.locator(".cm-link-card").first();
		await card.click({ button: "right" });
		await page.getByRole("menuitem", { name: "md リンクに変換" }).click();

		// 元の card は消える
		await expect(card).not.toBeVisible({ timeout: 3000 });
		// 新しく `[url](<url>)` 形式の md link widget が出現（label === URL）
		await expect(page.locator(".cm-link-widget", { hasText: URL_CARD })).toBeVisible();
	});

	test("「カードを削除」で URL 行が文書から消える", async ({ page }) => {
		await setupLinksFile(page);
		const editor = page.locator(".cm-content");

		const card = page.locator(".cm-link-card").first();
		await card.click({ button: "right" });
		await page.getByRole("menuitem", { name: "カードを削除" }).click();

		// card が消える + URL が editor 表示テキストに含まれなくなる
		// (削除されると widget も存在しなくなるので visible text からも消える)
		await expect(card).not.toBeVisible({ timeout: 3000 });
		await expect(editor).not.toContainText(URL_CARD);
	});
});

test.describe("md link widget — cmd/ctrl 押下中の class toggle (pointer cursor の前提)", () => {
	test("modifier 押下中だけ editor wrapper に `cm-link-mod-down` クラスが付く", async ({
		page,
	}) => {
		await setupLinksFile(page);
		const editor = page.locator(".cm-editor");

		// 初期状態: クラスなし
		await expect(editor).not.toHaveClass(/cm-link-mod-down/);

		// modifier 押下 → modifierTrackPlugin が window keydown を拾ってクラス付与
		await page.keyboard.down(modKey);
		await expect(editor).toHaveClass(/cm-link-mod-down/);

		// release
		await page.keyboard.up(modKey);
		await expect(editor).not.toHaveClass(/cm-link-mod-down/);
	});
});
