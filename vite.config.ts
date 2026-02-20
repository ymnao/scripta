/// <reference types="vitest" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const isTauriMock = process.env.TAURI_E2E_MOCK === "true";

// https://vite.dev/config/
export default defineConfig({
	plugins: [react(), tailwindcss()],

	// Tauri expects a fixed port; fail if that port is taken
	server: {
		port: 1420,
		strictPort: true,
	},

	// Expose TAURI_ENV_* (platform, debug) but not TAURI_SIGNING_* etc.
	envPrefix: ["VITE_", "TAURI_ENV_"],

	resolve: {
		alias: isTauriMock
			? {
					"@tauri-apps/api/core": path.resolve(__dirname, "e2e/mocks/tauri-api-core.ts"),
					"@tauri-apps/plugin-dialog": path.resolve(__dirname, "e2e/mocks/tauri-plugin-dialog.ts"),
					"@tauri-apps/plugin-shell": path.resolve(__dirname, "e2e/mocks/tauri-plugin-shell.ts"),
				}
			: undefined,
	},

	test: {
		environment: "jsdom",
		setupFiles: ["./src/test-setup.ts"],
		exclude: ["e2e/**", "node_modules/**"],
	},
});
