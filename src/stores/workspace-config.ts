import { create } from "zustand";
import { addTrailingSep } from "../lib/path";
import { loadIcons as loadIconsFromDisk, saveIcons, scriptaDirExists } from "../lib/scripta-config";

interface WorkspaceConfigState {
	icons: Record<string, string>;
	scriptaDirReady: boolean;

	loadIcons: (workspacePath: string) => Promise<void>;
	setIcon: (workspacePath: string, relativePath: string, emoji: string) => void;
	removeIcon: (workspacePath: string, relativePath: string) => void;
	setScriptaDirReady: (ready: boolean) => void;
	reset: () => void;
}

export function toRelativePath(workspacePath: string, absolutePath: string): string {
	const prefix = addTrailingSep(workspacePath);
	if (absolutePath.startsWith(prefix)) {
		return absolutePath.slice(prefix.length);
	}
	return absolutePath;
}

export const useWorkspaceConfigStore = create<WorkspaceConfigState>()((set, get) => ({
	icons: {},
	scriptaDirReady: false,

	loadIcons: async (workspacePath: string) => {
		const [icons, dirExists] = await Promise.all([
			loadIconsFromDisk(workspacePath),
			scriptaDirExists(workspacePath),
		]);
		set({ icons, scriptaDirReady: dirExists });
	},

	setIcon: (workspacePath: string, relativePath: string, emoji: string) => {
		const next = { ...get().icons, [relativePath]: emoji };
		set({ icons: next, scriptaDirReady: true });
		void saveIcons(workspacePath, next);
	},

	removeIcon: (workspacePath: string, relativePath: string) => {
		const { [relativePath]: _, ...rest } = get().icons;
		set({ icons: rest });
		void saveIcons(workspacePath, rest);
	},

	setScriptaDirReady: (ready: boolean) => set({ scriptaDirReady: ready }),

	reset: () => set({ icons: {}, scriptaDirReady: false }),
}));
