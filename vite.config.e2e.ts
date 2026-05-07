import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// e2e 専用の renderer-only Vite config。`electron-vite` を介さず素の Vite を起動して
// React アプリだけをブラウザに供する。Playwright は addInitScript で `window.api` の
// モックを注入するため、Electron / preload が無くてもフロント側の挙動を検証できる。
//
// `electron.vite.config.ts` の renderer セクションと **同じプラグイン構成・root** を保つこと。
// これがズレると本番ビルドと e2e で挙動が乖離する。
//
// port は `electron-vite dev`（5173）と衝突しないよう 5174 を固定で使う。
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
