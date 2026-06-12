import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const fs = {
	files: {
		"/workspace/test.md": "# Test",
	},
	directories: {
		"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
	},
};

test.describe("icon button tooltip", () => {
	test("ステータスバーの設定ボタンに hover で tooltip が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await expect(page.getByLabel("test.md file")).toBeVisible();

		const settingsButton = page.getByLabel("設定を開く");
		await settingsButton.hover();

		const tooltip = page.getByRole("tooltip");
		await expect(tooltip).toBeVisible();
		// キー表記（⌘ vs Ctrl）は実行環境 platform 依存なので label のみ assert する
		await expect(tooltip).toContainText("設定");
	});

	test("hover を外すと tooltip が消える", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await expect(page.getByLabel("test.md file")).toBeVisible();

		const settingsButton = page.getByLabel("設定を開く");
		await settingsButton.hover();
		await expect(page.getByRole("tooltip")).toBeVisible();

		// 別要素へ hover を移して tooltip を消す
		await page.getByLabel("test.md file").hover();
		await expect(page.getByRole("tooltip")).not.toBeVisible();
	});

	test("ステータスバーのファイルパスに hover で tooltip にパスが表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		// status bar はワークスペース相対パスを表示する。ネストしたファイルを開いて
		// 複数階層の相対パス（truncate されうる本来の用途）が tooltip に出ることを確認する。
		await mock.setup({
			fs: {
				files: {
					"/workspace/docs/readme.md": "# Readme",
				},
				directories: {
					"/workspace": [{ name: "docs", path: "/workspace/docs", isDirectory: true }],
					"/workspace/docs": [
						{ name: "readme.md", path: "/workspace/docs/readme.md", isDirectory: false },
					],
				},
			},
			dialogResult: "/workspace",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("docs folder").click();
		await page.getByLabel("readme.md file").click();

		const filePath = page.getByTestId("file-path");
		await expect(filePath).toBeVisible();
		await filePath.hover();

		const tooltip = page.getByRole("tooltip");
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toContainText("docs/readme.md");
	});

	test("新しいタブボタンに hover で tooltip が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await expect(page.getByLabel("test.md file")).toBeVisible();

		// 既定の「新しいタブ」タブの Close ボタン（aria-label="Close 新しいタブ"）と
		// 区別するため、ツールバーの追加ボタンを exact name で限定する。
		await page.getByRole("button", { name: "新しいタブ", exact: true }).hover();

		const tooltip = page.getByRole("tooltip");
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toContainText("新しいタブ");
	});

	test("右端のボタンでも tooltip が縦折れせず viewport 内に収まる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await expect(page.getByLabel("test.md file")).toBeVisible();

		// ステータスバー最右端のヘルプボタン。fixed + left の shrink-to-fit で利用可能幅が
		// 極小になり 1〜2 文字ずつ縦折れしていた回帰を検証する（w-max で内容幅基準にした）。
		await page.getByLabel("キーボードショートカット").hover();
		const tooltip = page.getByRole("tooltip");
		await expect(tooltip).toBeVisible();

		const box = await tooltip.boundingBox();
		const viewport = page.viewportSize();
		if (!box || !viewport) throw new Error("boundingBox / viewportSize が取得できない");
		// 縦折れしていない（1 行 = 横長）
		expect(box.width).toBeGreaterThan(box.height);
		// 横方向の clamp が効いて viewport 内に収まっている
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
	});

	test("無効状態の検索ナビボタンにも tooltip が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("test.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Test");

		// 検索未入力（マッチ 0 件）では「前の一致」は無効状態。disabled 属性だと
		// hover イベントごと抑制されて tooltip が出ない回帰を実ブラウザで検証する
		// （jsdom は disabled のイベント抑制を再現しないため e2e でのみ検証可能）。
		await page.keyboard.press(`${modKey}+f`);
		const prevButton = page.getByLabel("前の一致");
		await expect(prevButton).toHaveAttribute("aria-disabled", "true");

		await prevButton.hover();
		const tooltip = page.getByRole("tooltip");
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toContainText("前の一致");
	});
});
