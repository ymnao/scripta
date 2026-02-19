import { create } from "zustand";

type Theme = "light" | "dark";

interface ThemeState {
	theme: Theme;
	toggleTheme: () => void;
}

function applyTheme(theme: Theme) {
	if (typeof document !== "undefined") {
		document.documentElement.classList.toggle("dark", theme === "dark");
	}
}

function detectInitialTheme(): Theme {
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
			return { theme: next };
		});
	},
}));
