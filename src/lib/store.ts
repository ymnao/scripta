import { type Store, load } from "@tauri-apps/plugin-store";

export type ThemePreference = "system" | "light" | "dark";
export type FontFamily = "monospace" | "sans-serif" | "serif";
export type IndentSize = 2 | 4;

interface AppSettings {
	workspacePath: string | null;
	themePreference: ThemePreference;
	sidebarVisible: boolean;
	showLineNumbers: boolean;
	fontSize: number;
	autoSaveDelay: number;
	indentSize: IndentSize;
	highlightActiveLine: boolean;
	fontFamily: FontFamily;
	trimTrailingWhitespace: boolean;
}

const DEFAULTS: AppSettings = {
	workspacePath: null,
	themePreference: "system",
	sidebarVisible: true,
	showLineNumbers: true,
	fontSize: 14,
	autoSaveDelay: 2000,
	indentSize: 2,
	highlightActiveLine: false,
	fontFamily: "monospace",
	trimTrailingWhitespace: true,
};

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
	if (!storePromise) {
		storePromise = load("settings.json", { autoSave: false }).catch((error) => {
			storePromise = null;
			throw error;
		});
	}
	return storePromise;
}

export async function loadSettings(): Promise<AppSettings> {
	try {
		const store = await getStore();
		const workspacePath =
			(await store.get<string | null>("workspacePath")) ?? DEFAULTS.workspacePath;

		// Migration: convert legacy "theme" key to "themePreference"
		let themePreference: ThemePreference = DEFAULTS.themePreference;
		const rawThemePreference = await store.get<unknown>("themePreference");
		if (
			rawThemePreference === "system" ||
			rawThemePreference === "light" ||
			rawThemePreference === "dark"
		) {
			themePreference = rawThemePreference;
		} else {
			// Migrate from legacy "theme" key
			const rawTheme = await store.get<unknown>("theme");
			if (rawTheme === "light" || rawTheme === "dark") {
				themePreference = rawTheme;
			}
			// Persist migrated value and remove legacy key
			await store.set("themePreference", themePreference);
			await store.delete("theme");
			await store.save();
		}

		const rawSidebarVisible = await store.get<unknown>("sidebarVisible");
		const sidebarVisible: boolean =
			typeof rawSidebarVisible === "boolean" ? rawSidebarVisible : DEFAULTS.sidebarVisible;

		const rawShowLineNumbers = await store.get<unknown>("showLineNumbers");
		const showLineNumbers: boolean =
			typeof rawShowLineNumbers === "boolean" ? rawShowLineNumbers : DEFAULTS.showLineNumbers;

		const rawFontSize = await store.get<unknown>("fontSize");
		const fontSize: number =
			typeof rawFontSize === "number" && rawFontSize >= 8 && rawFontSize <= 32
				? rawFontSize
				: DEFAULTS.fontSize;

		const rawAutoSaveDelay = await store.get<unknown>("autoSaveDelay");
		const autoSaveDelay: number =
			typeof rawAutoSaveDelay === "number" && rawAutoSaveDelay >= 500 && rawAutoSaveDelay <= 10000
				? rawAutoSaveDelay
				: DEFAULTS.autoSaveDelay;

		const rawIndentSize = await store.get<unknown>("indentSize");
		const indentSize: IndentSize =
			rawIndentSize === 2 || rawIndentSize === 4 ? rawIndentSize : DEFAULTS.indentSize;

		const rawHighlightActiveLine = await store.get<unknown>("highlightActiveLine");
		const highlightActiveLine: boolean =
			typeof rawHighlightActiveLine === "boolean"
				? rawHighlightActiveLine
				: DEFAULTS.highlightActiveLine;

		const rawFontFamily = await store.get<unknown>("fontFamily");
		const fontFamily: FontFamily =
			rawFontFamily === "monospace" || rawFontFamily === "sans-serif" || rawFontFamily === "serif"
				? rawFontFamily
				: DEFAULTS.fontFamily;

		const rawTrimTrailingWhitespace = await store.get<unknown>("trimTrailingWhitespace");
		const trimTrailingWhitespace: boolean =
			typeof rawTrimTrailingWhitespace === "boolean"
				? rawTrimTrailingWhitespace
				: DEFAULTS.trimTrailingWhitespace;

		return {
			workspacePath,
			themePreference,
			sidebarVisible,
			showLineNumbers,
			fontSize,
			autoSaveDelay,
			indentSize,
			highlightActiveLine,
			fontFamily,
			trimTrailingWhitespace,
		};
	} catch {
		return { ...DEFAULTS };
	}
}

export async function saveWorkspacePath(path: string | null): Promise<void> {
	try {
		const store = await getStore();
		await store.set("workspacePath", path);
		await store.save();
	} catch {
		// Ignore save errors — app should continue working
	}
}

export async function saveThemePreference(preference: ThemePreference): Promise<void> {
	try {
		const store = await getStore();
		await store.set("themePreference", preference);
		await store.save();
	} catch {
		// Ignore save errors
	}
}

export async function saveSidebarVisible(visible: boolean): Promise<void> {
	try {
		const store = await getStore();
		await store.set("sidebarVisible", visible);
		await store.save();
	} catch {
		// Ignore save errors
	}
}

export async function saveShowLineNumbers(show: boolean): Promise<void> {
	try {
		const store = await getStore();
		await store.set("showLineNumbers", show);
		await store.save();
	} catch {
		// Ignore save errors
	}
}

export async function saveFontSize(size: number): Promise<void> {
	try {
		const store = await getStore();
		await store.set("fontSize", size);
		await store.save();
	} catch {
		// Ignore save errors
	}
}

export async function saveAutoSaveDelay(delay: number): Promise<void> {
	try {
		const store = await getStore();
		await store.set("autoSaveDelay", delay);
		await store.save();
	} catch {
		// Ignore save errors
	}
}

export async function saveIndentSize(size: IndentSize): Promise<void> {
	try {
		const store = await getStore();
		await store.set("indentSize", size);
		await store.save();
	} catch {
		// Ignore save errors
	}
}

export async function saveHighlightActiveLine(highlight: boolean): Promise<void> {
	try {
		const store = await getStore();
		await store.set("highlightActiveLine", highlight);
		await store.save();
	} catch {
		// Ignore save errors
	}
}

export async function saveFontFamily(family: FontFamily): Promise<void> {
	try {
		const store = await getStore();
		await store.set("fontFamily", family);
		await store.save();
	} catch {
		// Ignore save errors
	}
}

export async function saveTrimTrailingWhitespace(trim: boolean): Promise<void> {
	try {
		const store = await getStore();
		await store.set("trimTrailingWhitespace", trim);
		await store.save();
	} catch {
		// Ignore save errors
	}
}
