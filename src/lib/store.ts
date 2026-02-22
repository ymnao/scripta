import { type Store, load } from "@tauri-apps/plugin-store";

type Theme = "light" | "dark";

interface AppSettings {
	workspacePath: string | null;
	theme: Theme;
	sidebarVisible: boolean;
}

const DEFAULTS: AppSettings = {
	workspacePath: null,
	theme: "light",
	sidebarVisible: true,
};

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
	if (!storePromise) {
		storePromise = load("settings.json", { autoSave: false });
	}
	return storePromise;
}

export async function loadSettings(): Promise<AppSettings> {
	try {
		const store = await getStore();
		const workspacePath =
			(await store.get<string | null>("workspacePath")) ?? DEFAULTS.workspacePath;
		const theme = (await store.get<Theme>("theme")) ?? DEFAULTS.theme;
		const sidebarVisible = (await store.get<boolean>("sidebarVisible")) ?? DEFAULTS.sidebarVisible;
		return { workspacePath, theme, sidebarVisible };
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

export async function saveTheme(theme: Theme): Promise<void> {
	try {
		const store = await getStore();
		await store.set("theme", theme);
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
