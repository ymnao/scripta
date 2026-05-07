import { defineConfig, devices } from "@playwright/test";

// renderer-only モード（実 Electron は起動しない）。`window.api` は addInitScript で
// モック注入する。実 IPC / main プロセスは Vitest 側でカバー。

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
