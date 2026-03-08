import { create } from "zustand";
import { addTrailingSep, replacePrefix } from "../lib/path";
import { loadIcons as loadIconsFromDisk, saveIcons, scriptaDirExists } from "../lib/scripta-config";

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

export function toRelativePath(workspacePath: string, absolutePath: string): string {
	const prefix = addTrailingSep(workspacePath);
	const relative = absolutePath.startsWith(prefix)
		? absolutePath.slice(prefix.length)
		: absolutePath;
	return relative.replace(/\\/g, "/");
}

let loadIconsRequestId = 0;

export const useWorkspaceConfigStore = create<WorkspaceConfigState>()((set, get) => ({
	icons: {},
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
		const next = { ...get().icons, [relativePath]: emoji };
		set({ icons: next, scriptaDirReady: true });
		void saveIcons(workspacePath, next);
	},

	removeIcon: (workspacePath: string, relativePath: string) => {
		const icons = get().icons;
		const withSlash = relativePath.endsWith("/") ? relativePath : `${relativePath}/`;
		const withoutSlash = relativePath.endsWith("/") ? relativePath.slice(0, -1) : relativePath;
		const key = withSlash in icons ? withSlash : withoutSlash in icons ? withoutSlash : null;
		if (!key) return;
		const { [key]: _, ...rest } = icons;
		set({ icons: rest });
		void saveIcons(workspacePath, rest);
	},

	renameIcon: (workspacePath: string, oldRelPath: string, newRelPath: string) => {
		const icons = get().icons;
		if (!(oldRelPath in icons)) return;
		const { [oldRelPath]: emoji, ...rest } = icons;
		const next = { ...rest, [newRelPath]: emoji };
		set({ icons: next });
		void saveIcons(workspacePath, next);
	},

	renameIconsByPrefix: (workspacePath: string, oldPrefix: string, newPrefix: string) => {
		const icons = get().icons;
		const prefixWithSep = addTrailingSep(oldPrefix);
		let changed = false;
		const next: Record<string, string> = {};
		for (const [key, value] of Object.entries(icons)) {
			if (key === oldPrefix || key.startsWith(prefixWithSep)) {
				next[replacePrefix(key, oldPrefix, newPrefix)] = value;
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
		const next: Record<string, string> = {};
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
		set({ icons: {}, scriptaDirReady: false });
	},
}));
