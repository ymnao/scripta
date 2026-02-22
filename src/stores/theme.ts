import { create } from "zustand";
import { saveTheme } from "../lib/store";

type Theme = "light" | "dark";

interface ThemeState {
	theme: Theme;
	toggleTheme: () => void;
	setTheme: (theme: Theme) => void;
}

function applyTheme(theme: Theme) {
	if (typeof document !== "undefined") {
		document.documentElement.classList.toggle("dark", theme === "dark");
	}
	// Mirror to localStorage for synchronous access in theme-init.js (FOUC prevention).
	// The canonical store is tauri-plugin-store; localStorage is a sync cache only.
	try {
		localStorage.setItem("mark-draft-theme", theme);
	} catch {
		// Ignore — localStorage may be unavailable (e.g. private browsing)
	}
}

function detectInitialTheme(): Theme {
	try {
		const stored = localStorage.getItem("mark-draft-theme");
		if (stored === "dark" || stored === "light") return stored;
	} catch {
		// Ignore — localStorage may be unavailable (e.g. private browsing)
	}
	if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
		return "dark";
	}
	return "light";
}

const initialTheme = detectInitialTheme();
applyTheme(initialTheme);

export const useThemeStore = create<ThemeState>()((set) => ({
	theme: initialTheme,
	toggleTheme: () => {
		set((state) => {
			const next = state.theme === "light" ? "dark" : "light";
			applyTheme(next);
			void saveTheme(next);
			return { theme: next };
		});
	},
	setTheme: (theme: Theme) => {
		applyTheme(theme);
		void saveTheme(theme);
		set({ theme });
	},
}));
