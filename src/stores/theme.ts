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
	if (typeof localStorage !== "undefined") {
		localStorage.setItem("mark-draft-theme", theme);
	}
}

function detectInitialTheme(): Theme {
	if (typeof localStorage !== "undefined") {
		const stored = localStorage.getItem("mark-draft-theme");
		if (stored === "dark" || stored === "light") return stored;
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
		set({ theme });
	},
}));
