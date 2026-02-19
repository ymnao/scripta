import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
	plugins: [react()],

	// Tauri expects a fixed port; fail if that port is taken
	server: {
		port: 1420,
		strictPort: true,
	},

	// Tauri environment variables
	envPrefix: ["VITE_", "TAURI_"],
});
