/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		setupFiles: ["./src/test-setup.ts"],
		include: ["src/**/*.test.{ts,tsx}"],
		exclude: [...configDefaults.exclude, "e2e/**", "out/**"],
		// EmojiInputDialog は emoji-data.ts (2914 行) の全絵文字を jsdom で render
		// するため、CPU 競合下では default 5000ms に間に合わないテストがある。
		// 15s に伸ばして余裕を確保する（実際は通常 1〜3s で完了する）。
		testTimeout: 15_000,
	},
});
