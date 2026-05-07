import { defineConfig, devices } from "@playwright/test";

// e2e は **renderer-only モード**（`vite --config vite.config.e2e.ts`）の Chromium に対して
// 動かす。実 Electron は起動しない。`window.api` は addInitScript でモック注入するため、
// 旧 Tauri 版の `tauri-mock.ts` 戦略を踏襲し、フロントエンドのテストを軽量に回す。
//
// 実 IPC や main プロセスのテストは Vitest 側（`electron/main/**/*.test.ts`）でカバー済み。
// e2e は「フロントが期待通りの UI 挙動を示すか」だけを担う。

const PORT = 5174;

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? "50%" : undefined,
	reporter: process.env.CI ? [["dot"], ["github"]] : "html",
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				// Desktop Chrome の userAgent は Windows を装うため、CodeMirror の
				// platform 検出（Mod キーが Meta/Control どちらにマップされるか）が
				// host OS と一致しなくなる。空にしてネイティブ UA を使わせる。
				userAgent: undefined,
			},
		},
	],
	webServer: {
		command: "pnpm dev:e2e",
		url: `http://localhost:${PORT}`,
		reuseExistingServer: !process.env.CI,
		stdout: "ignore",
		stderr: "pipe",
	},
});
