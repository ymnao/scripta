import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `electron.vite.config.ts` の renderer セクションと同じプラグイン構成・root を保つこと
// — ズレると本番ビルドと e2e で挙動が乖離する。port は `electron-vite dev`（5173）と
// 衝突しないよう 5174 固定。host 未指定だと Vite は `localhost` を bind し、IPv6 制限環境
//（sandbox 等）で `::1` への listen が EPERM になるため `127.0.0.1` を明示する（#171）。

const root = import.meta.dirname;

export default defineConfig({
	root,
	plugins: [react(), tailwindcss()],
	server: {
		host: "127.0.0.1",
		port: 5174,
		strictPort: true,
	},
	build: {
		rollupOptions: {
			input: join(root, "index.html"),
		},
	},
});
