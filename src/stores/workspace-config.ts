import { create } from "zustand";
import { addTrailingSep, replacePrefix, toRelativePath } from "../lib/path";
import { loadIcons as loadIconsFromDisk, saveIcons, scriptaDirExists } from "../lib/scripta-config";

export { toRelativePath };

interface WorkspaceConfigState {
	icons: Record<string, string>;
	scriptaDirReady: boolean;

	loadIcons: (workspacePath: string) => Promise<void>;
	setIcon: (workspacePath: string, relativePath: string, emoji: string) => void;
	removeIcon: (workspacePath: string, relativePath: string) => void;
	renameIcon: (workspacePath: string, oldRelPath: string, newRelPath: string) => void;
	renameIconsByPrefix: (workspacePath: string, oldPrefix: string, newPrefix: string) => void;
	deleteIconsByPrefix: (workspacePath: string, prefix: string) => void;
	setScriptaDirReady: (ready: boolean) => void;
	reset: () => void;
}

let loadIconsRequestId = 0;

export const useWorkspaceConfigStore = create<WorkspaceConfigState>()((set, get) => ({
	icons: Object.create(null) as Record<string, string>,
	scriptaDirReady: false,

	loadIcons: async (workspacePath: string) => {
		const requestId = ++loadIconsRequestId;
		const [icons, dirExists] = await Promise.all([
			loadIconsFromDisk(workspacePath),
			scriptaDirExists(workspacePath),
		]);
		if (requestId !== loadIconsRequestId) return;
		set({ icons, scriptaDirReady: dirExists });
	},

	setIcon: (workspacePath: string, relativePath: string, emoji: string) => {
		const next: Record<string, string> = Object.create(null);
		Object.assign(next, get().icons, { [relativePath]: emoji });
		set({ icons: next, scriptaDirReady: true });
		void saveIcons(workspacePath, next);
	},

	removeIcon: (workspacePath: string, relativePath: string) => {
		const icons = get().icons;
		const withSlash = relativePath.endsWith("/") ? relativePath : `${relativePath}/`;
		const withoutSlash = relativePath.endsWith("/") ? relativePath.slice(0, -1) : relativePath;
		const key = Object.hasOwn(icons, withSlash)
			? withSlash
			: Object.hasOwn(icons, withoutSlash)
				? withoutSlash
				: null;
		if (!key) return;
		const next: Record<string, string> = Object.create(null);
		for (const [k, v] of Object.entries(icons)) {
			if (k !== key) next[k] = v;
		}
		set({ icons: next });
		void saveIcons(workspacePath, next);
	},

	renameIcon: (workspacePath: string, oldRelPath: string, newRelPath: string) => {
		const icons = get().icons;
		if (!Object.hasOwn(icons, oldRelPath)) return;
		const next: Record<string, string> = Object.create(null);
		for (const [k, v] of Object.entries(icons)) {
			if (k === oldRelPath) {
				next[newRelPath] = v;
			} else {
				next[k] = v;
			}
		}
		set({ icons: next });
		void saveIcons(workspacePath, next);
	},

	renameIconsByPrefix: (workspacePath: string, oldPrefix: string, newPrefix: string) => {
		const icons = get().icons;
		const prefixWithSep = addTrailingSep(oldPrefix);
		let changed = false;
		const next: Record<string, string> = Object.create(null);
		for (const [key, value] of Object.entries(icons)) {
			if (key === oldPrefix || key.startsWith(prefixWithSep)) {
				const hadTrailingSep = key.endsWith("/");
				let newKey = replacePrefix(key, oldPrefix, newPrefix);
				if (hadTrailingSep && !newKey.endsWith("/")) {
					newKey += "/";
				}
				next[newKey] = value;
				changed = true;
			} else {
				next[key] = value;
			}
		}
		if (!changed) return;
		set({ icons: next });
		void saveIcons(workspacePath, next);
	},

	deleteIconsByPrefix: (workspacePath: string, prefix: string) => {
		const icons = get().icons;
		const prefixWithSep = addTrailingSep(prefix);
		const next: Record<string, string> = Object.create(null);
		let changed = false;
		for (const [key, value] of Object.entries(icons)) {
			if (key === prefix || key.startsWith(prefixWithSep)) {
				changed = true;
			} else {
				next[key] = value;
			}
		}
		if (!changed) return;
		set({ icons: next });
		void saveIcons(workspacePath, next);
	},

	setScriptaDirReady: (ready: boolean) => set({ scriptaDirReady: ready }),

	reset: () => {
		loadIconsRequestId++;
		set({ icons: Object.create(null) as Record<string, string>, scriptaDirReady: false });
	},
}));
