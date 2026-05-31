import { expect, test } from "./helpers/launch";

// _electron ハーネスのパイプライン健全性確認（build 成果物起動 → 実 main + preload +
// 実 IPC → renderer 描画）。8 領域 safety net の土台が機能することを保証する最小テスト。
test.describe("electron smoke", () => {
	test("build 成果物を起動するとメインウィンドウが開きワークスペース未選択 UI が出る", async ({
		launch,
	}) => {
		const { page } = await launch();

		// workspace 未設定の temp userData なので Open Folder ボタンが描画される。
		await expect(page.getByLabel("Open folder")).toBeVisible();
	});

	test("preload contextBridge 経由で window.api が露出している", async ({ launch }) => {
		const { page } = await launch();

		// 実 preload が contextIsolation 越しに window.api を公開していることを確認。
		// mock 注入ではない実 API 表面を踏むことで preload 実装ミスを検出する。
		const apiShape = await page.evaluate(() => {
			const api = (window as unknown as { api?: Record<string, unknown> }).api;
			return {
				present: typeof api === "object" && api !== null,
				hasSettingsGet: typeof api?.settingsGet === "function",
				hasListDirectory: typeof api?.listDirectory === "function",
			};
		});

		expect(apiShape.present).toBe(true);
		expect(apiShape.hasSettingsGet).toBe(true);
		expect(apiShape.hasListDirectory).toBe(true);
	});
});
