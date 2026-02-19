import { create } from "zustand";

type Theme = "light" | "dark";

interface ThemeState {
	theme: Theme;
	toggleTheme: () => void;
}

function applyTheme(theme: Theme) {
	document.documentElement.classList.toggle("dark", theme === "dark");
}

const initialTheme: Theme = window.matchMedia("(prefers-color-scheme: dark)").matches
	? "dark"
	: "light";
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
