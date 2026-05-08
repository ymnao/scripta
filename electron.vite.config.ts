import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const root = import.meta.dirname;

// `electron` は devDependencies に置く慣例で、externalizeDepsPlugin の
// デフォルトは dependencies のみを external にするため、明示的に rollupOptions.external で
// 指定しないと `@electron-toolkit/utils` などの transitive ESM import 経由で
// electron の index.js が bundle に取り込まれる。
// electron 41 まではシンプルな path 返却で害が無かったが、42 から lazy download
// ロジックが入ったため、bundle された __dirname が path.txt を見失って
// `Electron failed to install correctly` エラーで起動失敗する。
// 上流の慣例どおり electron は runtime に CLI が hijack するモジュールなので external 必須。
const externalElectron = ["electron", /^electron\/.+/] as const;

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: join(root, "electron/main/index.ts"),
				external: [...externalElectron],
				output: {
					format: "cjs",
					entryFileNames: "[name].js",
				},
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: join(root, "electron/preload/index.ts"),
				external: [...externalElectron],
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
				input: join(root, "index.html"),
			},
		},
	},
});
