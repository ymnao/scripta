/// <reference types="vitest" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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

	test: {
		environment: "jsdom",
		setupFiles: ["./src/test-setup.ts"],
	},
});
