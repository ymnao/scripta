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
