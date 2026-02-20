import { create } from "zustand";

export interface Tab {
	path: string;
	dirty: boolean;
}

interface WorkspaceState {
	workspacePath: string | null;
	tabs: Tab[];
	activeTabPath: string | null;

	setWorkspacePath: (path: string | null) => void;
	openTab: (path: string) => void;
	closeTab: (path: string) => void;
	setActiveTab: (path: string) => void;
	setTabDirty: (path: string, dirty: boolean) => void;
	renameTab: (oldPath: string, newPath: string) => void;
	closeTabsByPrefix: (prefix: string) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
	workspacePath: null,
	tabs: [],
	activeTabPath: null,

	setWorkspacePath: (path) => set({ workspacePath: path, tabs: [], activeTabPath: null }),

	openTab: (path) =>
		set((state) => {
			const existing = state.tabs.find((t) => t.path === path);
			if (existing) {
				return { activeTabPath: path };
			}
			return {
				tabs: [...state.tabs, { path, dirty: false }],
				activeTabPath: path,
			};
		}),

	closeTab: (path) =>
		set((state) => {
			const index = state.tabs.findIndex((t) => t.path === path);
			if (index === -1) return state;

			const newTabs = state.tabs.filter((t) => t.path !== path);

			if (state.activeTabPath !== path) {
				return { tabs: newTabs };
			}

			let newActive: string | null = null;
			if (newTabs.length > 0) {
				newActive = index < newTabs.length ? newTabs[index].path : newTabs[newTabs.length - 1].path;
			}

			return { tabs: newTabs, activeTabPath: newActive };
		}),

	setActiveTab: (path) =>
		set((state) => {
			if (!state.tabs.some((t) => t.path === path)) return state;
			return { activeTabPath: path };
		}),

	setTabDirty: (path, dirty) =>
		set((state) => ({
			tabs: state.tabs.map((t) => (t.path === path ? { ...t, dirty } : t)),
		})),

	renameTab: (oldPath, newPath) =>
		set((state) => ({
			tabs: state.tabs.map((t) => (t.path === oldPath ? { ...t, path: newPath } : t)),
			activeTabPath: state.activeTabPath === oldPath ? newPath : state.activeTabPath,
		})),

	closeTabsByPrefix: (prefix) =>
		set((state) => {
			const activeIndex =
				state.activeTabPath != null
					? state.tabs.findIndex((t) => t.path === state.activeTabPath)
					: -1;
			const newTabs = state.tabs.filter((t) => !t.path.startsWith(prefix));
			if (newTabs.length === state.tabs.length) return state;

			let newActive = state.activeTabPath;
			if (newActive?.startsWith(prefix)) {
				if (newTabs.length > 0) {
					const newIndex =
						activeIndex >= 0 ? Math.min(activeIndex, newTabs.length - 1) : newTabs.length - 1;
					newActive = newTabs[newIndex].path;
				} else {
					newActive = null;
				}
			}

			return { tabs: newTabs, activeTabPath: newActive };
		}),
}));
