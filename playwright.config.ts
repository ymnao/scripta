import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? "50%" : undefined,
	reporter: process.env.CI ? [["dot"], ["github"]] : "html",
	use: {
		baseURL: "http://localhost:1420",
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				// Reset the Windows user agent from "Desktop Chrome" device descriptor
				// so Chromium uses its native UA. This ensures CodeMirror correctly detects
				// the host platform and maps Mod key to Meta (macOS) or Control (Linux/Windows).
				userAgent: undefined,
			},
		},
	],
	webServer: {
		command: "pnpm dev",
		url: "http://localhost:1420",
		reuseExistingServer: !process.env.CI,
		env: {
			TAURI_E2E_MOCK: "true",
			...(process.env.NO_COLOR ? { FORCE_COLOR: "0" } : {}),
		},
	},
});
