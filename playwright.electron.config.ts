import { defineConfig } from "@playwright/test";

// 実 Electron 起動モード（`_electron.launch` で build 成果物 `out/main/index.js` を
// 直接起動）。renderer-only モードの `playwright.config.ts` とは別 config に分離する:
//   - webServer / baseURL は不要（各テストが自前で Electron を起動）
//   - 実 main プロセス + preload + 実 IPC を回し、設定永続化 / asset protocol /
//     マルチウィンドウ等、mock では検出できない main 境界を safety net 化する
//   - 起動成果物は `pnpm test:e2e:electron` が事前に `electron-vite build` で生成する
//
// 既存 mock spec (`e2e/*.spec.ts`) は従来どおり `playwright.config.ts` で並行運用する。

export default defineConfig({
	testDir: "./e2e/electron",
	testMatch: "**/*.electron.spec.ts",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	// Electron インスタンスは renderer-only より遥かに重い（プロセス起動 + GPU/描画）。
	// CI ランナーのメモリ枯渇を避けるため worker を絞る。local は既定（CPU 依存）。
	workers: process.env.CI ? 2 : undefined,
	reporter: process.env.CI
		? [["dot"], ["github"], ["html", { open: "never", outputFolder: "playwright-report-electron" }]]
		: [["list"], ["html", { open: "never", outputFolder: "playwright-report-electron" }]],
	use: {
		trace: "on-first-retry",
	},
});
