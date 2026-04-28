import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: new URL("electron/main/index.ts", import.meta.url).pathname,
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: new URL("electron/preload/index.ts", import.meta.url).pathname,
				output: {
					format: "cjs",
					entryFileNames: "[name].js",
				},
			},
		},
	},
	renderer: {
		root,
		plugins: [react(), tailwindcss()],
		build: {
			rollupOptions: {
				input: new URL("index.html", import.meta.url).pathname,
			},
		},
	},
});
