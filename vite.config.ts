/// <reference types="vitest" />
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

	build: {
		// Tauri デスクトップアプリではチャンク分割のパフォーマンス効果は薄いが、
		// ビルド時の 500 KB 超過警告を解消するためにベンダーチャンクを分離する
		rolldownOptions: {
			output: {
				codeSplitting: {
					// CodeMirror を core/ext に分割するのは単一グループだと 500 KB を超えるため
					groups: [
						{
							name: "vendor-react",
							test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
							priority: 3,
						},
						{
							name: "vendor-codemirror-core",
							test: /node_modules[\\/](@codemirror[\\/](state|view)|@lezer[\\/](common|lr)|crelt|style-mod|w3c-keyname)[\\/]/,
							priority: 2,
						},
						{
							name: "vendor-codemirror-ext",
							test: /node_modules[\\/](@codemirror[\\/](autocomplete|commands|lang-markdown|language-data|language|search)|@lezer[\\/](highlight|markdown)|@uiw[\\/]react-codemirror)[\\/]/,
							priority: 2,
						},
					],
				},
			},
		},
	},

	resolve: {
		alias: isTauriMock
			? {
					"@tauri-apps/api/core": path.resolve(__dirname, "e2e/mocks/tauri-api-core.ts"),
					"@tauri-apps/plugin-dialog": path.resolve(__dirname, "e2e/mocks/tauri-plugin-dialog.ts"),
					"@tauri-apps/plugin-shell": path.resolve(__dirname, "e2e/mocks/tauri-plugin-shell.ts"),
					"@tauri-apps/api/event": path.resolve(__dirname, "e2e/mocks/tauri-api-event.ts"),
					"@tauri-apps/api/window": path.resolve(__dirname, "e2e/mocks/tauri-api-window.ts"),
					"@tauri-apps/plugin-store": path.resolve(__dirname, "e2e/mocks/tauri-plugin-store.ts"),
					"@tauri-apps/api/webviewWindow": path.resolve(
						__dirname,
						"e2e/mocks/tauri-api-webview-window.ts",
					),
				}
			: undefined,
	},

	test: {
		environment: "jsdom",
		setupFiles: ["./src/test-setup.ts"],
		exclude: [...configDefaults.exclude, "e2e/**"],
	},
});
