import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `electron.vite.config.ts` の renderer セクションと同じプラグイン構成・root を保つこと
// — ズレると本番ビルドと e2e で挙動が乖離する。port は `electron-vite dev`（5173）と
// 衝突しないよう 5174 固定。

const root = import.meta.dirname;

export default defineConfig({
	root,
	plugins: [react(), tailwindcss()],
	server: {
		port: 5174,
		strictPort: true,
	},
	build: {
		rollupOptions: {
			input: join(root, "index.html"),
		},
	},
});
