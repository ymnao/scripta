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

// Chromium 固定（Electron 42 = Chromium 148 / 同梱 Node.js 22 系）に伴い、
// 多 WebView 互換のための保守的 transpile を解除して build target を実態へ揃える。
//   - renderer は固定 Chromium 実行なので chrome148 を明示。esnext ではなく実 Chromium 版を
//     指すことで、依存や自前コードに将来構文が混入しても Electron 42 が parse できる範囲へ
//     down-level される（esnext は「変換しない」指定で素通りし、起動時 parse error になり得る）。
//   - main / preload は Node.js 実行のため node 系ターゲットが必須
//     （electron-vite が main/preload の build.target を "node?" に制約しており esnext は拒否される）。
//     Electron 42 同梱 Node は >= 22.12 のため node22 を明示。
// なお electron-vite v5 の getElectronNodeTarget() は Electron 39 までしかマップを持たず、
// 42 では stale fallback で node16.17 に解決される。ここで明示することでその過度な
// down-level 化も同時に矯正する。
// Chromium 版は electron-to-chromium の Electron 42.0 → 148 マッピングに基づく。
const RENDERER_TARGET = "chrome148" as const;
const NODE_TARGET = "node22" as const;

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			target: NODE_TARGET,
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
			target: NODE_TARGET,
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
			target: RENDERER_TARGET,
			rollupOptions: {
				input: join(root, "index.html"),
			},
		},
	},
});
