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
	},
});
