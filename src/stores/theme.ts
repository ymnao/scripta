import { create } from "zustand";
import { saveThemePreference, type ThemePreference } from "../lib/store";

type Theme = "light" | "dark";

interface ThemeState {
	preference: ThemePreference;
	theme: Theme;
	setPreference: (pref: ThemePreference) => void;
	cyclePreference: () => void;
	/** Set preference without persisting to store — used for initial hydration */
	hydratePreference: (pref: ThemePreference) => void;
}

function applyTheme(theme: Theme) {
	if (typeof document !== "undefined") {
		document.documentElement.classList.toggle("dark", theme === "dark");
	}
	// Mirror to localStorage for synchronous access in theme-init.js (FOUC prevention).
	// The canonical store is tauri-plugin-store; localStorage is a sync cache only.
	try {
		localStorage.setItem("scripta-theme", theme);
	} catch {
		// Ignore — localStorage may be unavailable (e.g. private browsing)
	}
}

function resolveTheme(pref: ThemePreference): Theme {
	if (pref === "light" || pref === "dark") return pref;
	// pref === "system"
	if (
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-color-scheme: dark)").matches
	) {
		return "dark";
	}
	return "light";
}

function detectInitialPreference(): ThemePreference {
	try {
		let stored = localStorage.getItem("scripta-theme-preference");
		if (!stored) {
			// Migrate from old key
			const old = localStorage.getItem("mark-draft-theme-preference");
			if (old) {
				stored = old;
				localStorage.setItem("scripta-theme-preference", old);
				localStorage.removeItem("mark-draft-theme-preference");
			}
		}
		if (stored === "system" || stored === "light" || stored === "dark") return stored;
	} catch {
		// Ignore
	}
	// Fallback: check legacy theme cache for initial render
	try {
		let legacy = localStorage.getItem("scripta-theme");
		if (!legacy) {
			const old = localStorage.getItem("mark-draft-theme");
			if (old) {
				legacy = old;
				localStorage.setItem("scripta-theme", old);
				localStorage.removeItem("mark-draft-theme");
			}
		}
		if (legacy === "light" || legacy === "dark") return legacy;
	} catch {
		// Ignore
	}
	return "system";
}

function persistPreferenceToLocalStorage(pref: ThemePreference) {
	try {
		localStorage.setItem("scripta-theme-preference", pref);
	} catch {
		// Ignore
	}
}

const initialPreference = detectInitialPreference();
const initialTheme = resolveTheme(initialPreference);
applyTheme(initialTheme);

const CYCLE_ORDER: ThemePreference[] = ["system", "light", "dark"];

export const useThemeStore = create<ThemeState>()((set, get) => ({
	preference: initialPreference,
	theme: initialTheme,
	setPreference: (pref: ThemePreference) => {
		const theme = resolveTheme(pref);
		applyTheme(theme);
		persistPreferenceToLocalStorage(pref);
		void saveThemePreference(pref);
		set({ preference: pref, theme });
	},
	cyclePreference: () => {
		const current = get().preference;
		const idx = CYCLE_ORDER.indexOf(current);
		const next = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
		get().setPreference(next);
	},
	hydratePreference: (pref: ThemePreference) => {
		const theme = resolveTheme(pref);
		applyTheme(theme);
		persistPreferenceToLocalStorage(pref);
		set({ preference: pref, theme });
	},
}));

// Listen for OS theme changes — update resolved theme when preference is "system".
// Store references for cleanup (HMR / test re-initialization).
let osThemeQuery: MediaQueryList | null = null;
const osThemeHandler = () => {
	const state = useThemeStore.getState();
	if (state.preference === "system") {
		const theme = resolveTheme("system");
		applyTheme(theme);
		useThemeStore.setState({ theme });
	}
};

function registerOsThemeListener() {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
	// Prevent duplicate registration (HMR)
	if (osThemeQuery) return;
	osThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
	osThemeQuery.addEventListener("change", osThemeHandler);
}

registerOsThemeListener();

// Allow cleanup in HMR — Vite calls import.meta.hot.dispose
if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		if (osThemeQuery) {
			osThemeQuery.removeEventListener("change", osThemeHandler);
			osThemeQuery = null;
		}
	});
}
