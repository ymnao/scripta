/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		projects: [
			{
				extends: true,
				test: {
					name: "renderer",
					environment: "jsdom",
					setupFiles: ["./src/test-setup.ts"],
					include: ["src/**/*.test.{ts,tsx}"],
					exclude: [...configDefaults.exclude, "e2e/**", "out/**"],
					// Node.js 26+ の experimental localStorage が jsdom の
					// window.localStorage を shadow する問題の回避。
					// CI は Node 22 で無害、Node 26+ では根本原因を消す。
					execArgv: ["--no-experimental-webstorage"],
				},
			},
			{
				extends: true,
				test: {
					name: "main",
					environment: "node",
					include: ["electron/**/*.test.ts"],
					exclude: [...configDefaults.exclude, "e2e/**", "out/**"],
				},
			},
		],
	},
});
