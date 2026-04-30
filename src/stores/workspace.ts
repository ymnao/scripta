import { create } from "zustand";
import { createNewTabPath, isNewTabPath } from "../lib/path";

const MAX_HISTORY = 100;

export interface Tab {
	id: number;
	path: string;
	dirty: boolean;
	history: string[];
	historyIndex: number;
}

interface WorkspaceState {
	workspacePath: string | null;
	tabs: Tab[];
	activeTabPath: string | null;
	activeTabId: number | null;
	_nextTabId: number;
	fileTreeVersion: number;
	contentVersion: number;

	setWorkspacePath: (path: string | null) => void;
	openTab: (path: string) => void;
	closeTab: (path: string) => void;
	closeTabById: (id: number) => void;
	setActiveTab: (path: string) => void;
	setActiveTabById: (id: number) => void;
	setTabDirty: (path: string, dirty: boolean) => void;
	renameTab: (oldPath: string, newPath: string) => void;
	renameTabsByPrefix: (oldPrefix: string, newPrefix: string) => void;
	closeTabsByPrefix: (prefix: string) => void;
	bumpFileTreeVersion: () => void;
	bumpContentVersion: () => void;
	navigateInTab: (path: string) => void;
	goBackInTab: () => void;
	goForwardInTab: () => void;
	reorderTab: (fromIndex: number, toIndex: number) => void;
	openNewTab: () => void;
	activateNextTab: () => void;
	activatePrevTab: () => void;
}

function closeTabAt(state: WorkspaceState, index: number): Partial<WorkspaceState> {
	const newTabs = state.tabs.filter((_, i) => i !== index);
	const closedTab = state.tabs[index];
	if (state.activeTabId !== closedTab.id) {
		return { tabs: newTabs };
	}
	let newActive: Tab | null = null;
	if (newTabs.length > 0) {
		newActive = index < newTabs.length ? newTabs[index] : newTabs[newTabs.length - 1];
	}
	return {
		tabs: newTabs,
		activeTabPath: newActive?.path ?? null,
		activeTabId: newActive?.id ?? null,
	};
}

function navigateHistory(state: WorkspaceState, direction: -1 | 1): Partial<WorkspaceState> {
	const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
	if (!activeTab) return state;
	const newIndex = activeTab.historyIndex + direction;
	if (newIndex < 0 || newIndex >= activeTab.history.length) return state;
	const newPath = activeTab.history[newIndex];
	return {
		tabs: state.tabs.map((t) =>
			t.id === activeTab.id ? { ...t, path: newPath, historyIndex: newIndex } : t,
		),
		activeTabPath: newPath,
	};
}

function activateTabByOffset(state: WorkspaceState, offset: number): Partial<WorkspaceState> {
	if (state.tabs.length <= 1) return state;
	const index = state.tabs.findIndex((t) => t.id === state.activeTabId);
	const nextIndex = (index + offset + state.tabs.length) % state.tabs.length;
	const next = state.tabs[nextIndex];
	return { activeTabPath: next.path, activeTabId: next.id };
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
	workspacePath: null,
	tabs: [],
	activeTabPath: null,
	activeTabId: null,
	_nextTabId: 1,
	fileTreeVersion: 0,
	contentVersion: 0,

	setWorkspacePath: (path) =>
		set({
			workspacePath: path,
			tabs: [],
			activeTabPath: null,
			activeTabId: null,
			_nextTabId: 1,
			fileTreeVersion: 0,
			contentVersion: 0,
		}),

	bumpFileTreeVersion: () => set((s) => ({ fileTreeVersion: s.fileTreeVersion + 1 })),

	bumpContentVersion: () => set((s) => ({ contentVersion: s.contentVersion + 1 })),

	openTab: (path) =>
		set((state) => {
			const existing = state.tabs.find((t) => t.path === path);
			if (existing) {
				return { activeTabPath: path, activeTabId: existing.id };
			}
			const id = state._nextTabId;
			return {
				tabs: [...state.tabs, { id, path, dirty: false, history: [path], historyIndex: 0 }],
				activeTabPath: path,
				activeTabId: id,
				_nextTabId: id + 1,
			};
		}),

	closeTab: (path) =>
		set((state) => {
			const index = state.tabs.findIndex((t) => t.path === path);
			if (index === -1) return state;
			return closeTabAt(state, index);
		}),

	closeTabById: (id) =>
		set((state) => {
			const index = state.tabs.findIndex((t) => t.id === id);
			if (index === -1) return state;
			return closeTabAt(state, index);
		}),

	setActiveTab: (path) =>
		set((state) => {
			const tab = state.tabs.find((t) => t.path === path);
			if (!tab) return state;
			return { activeTabPath: path, activeTabId: tab.id };
		}),

	setActiveTabById: (id) =>
		set((state) => {
			const tab = state.tabs.find((t) => t.id === id);
			if (!tab) return state;
			return { activeTabPath: tab.path, activeTabId: tab.id };
		}),

	setTabDirty: (path, dirty) =>
		set((state) => {
			const tab = state.tabs.find((t) => t.path === path);
			if (!tab || tab.dirty === dirty) return state;
			return { tabs: state.tabs.map((t) => (t.path === path ? { ...t, dirty } : t)) };
		}),

	renameTab: (oldPath, newPath) =>
		set((state) => ({
			tabs: state.tabs.map((t) =>
				t.path === oldPath
					? {
							...t,
							path: newPath,
							history: t.history.map((p) => (p === oldPath ? newPath : p)),
						}
					: t,
			),
			activeTabPath: state.activeTabPath === oldPath ? newPath : state.activeTabPath,
		})),

	renameTabsByPrefix: (oldPrefix, newPrefix) =>
		set((state) => ({
			tabs: state.tabs.map((t) => {
				const newPath = t.path.startsWith(oldPrefix)
					? newPrefix + t.path.slice(oldPrefix.length)
					: t.path;
				const newHistory = t.history.map((p) =>
					p.startsWith(oldPrefix) ? newPrefix + p.slice(oldPrefix.length) : p,
				);
				if (newPath === t.path && newHistory.every((p, i) => p === t.history[i])) return t;
				return { ...t, path: newPath, history: newHistory };
			}),
			activeTabPath: state.activeTabPath?.startsWith(oldPrefix)
				? newPrefix + state.activeTabPath.slice(oldPrefix.length)
				: state.activeTabPath,
		})),

	navigateInTab: (path) =>
		set((state) => {
			const activeTab = state.tabs.find((t) => t.id === state.activeTabId);

			// Same path as current → no-op
			if (activeTab?.path === path) return state;

			// Another tab already shows this path → switch to it
			const existing = state.tabs.find((t) => t.path === path);
			if (existing) {
				return { activeTabPath: path, activeTabId: existing.id };
			}

			// No active tab → create new
			if (!activeTab) {
				const id = state._nextTabId;
				return {
					tabs: [...state.tabs, { id, path, dirty: false, history: [path], historyIndex: 0 }],
					activeTabPath: path,
					activeTabId: id,
					_nextTabId: id + 1,
				};
			}

			// Push to active tab's history
			const trimmed = activeTab.history.slice(0, activeTab.historyIndex + 1);
			const next = [...trimmed, path];
			if (next.length > MAX_HISTORY) {
				next.splice(0, next.length - MAX_HISTORY);
			}
			const newIndex = next.length - 1;

			return {
				tabs: state.tabs.map((t) =>
					t.id === activeTab.id
						? { ...t, path, dirty: false, history: next, historyIndex: newIndex }
						: t,
				),
				activeTabPath: path,
			};
		}),

	goBackInTab: () => set((state) => navigateHistory(state, -1)),

	goForwardInTab: () => set((state) => navigateHistory(state, 1)),

	reorderTab: (fromIndex, toIndex) =>
		set((state) => {
			if (
				fromIndex === toIndex ||
				fromIndex < 0 ||
				toIndex < 0 ||
				fromIndex >= state.tabs.length ||
				toIndex >= state.tabs.length
			) {
				return state;
			}
			const newTabs = [...state.tabs];
			const [moved] = newTabs.splice(fromIndex, 1);
			newTabs.splice(toIndex, 0, moved);
			return { tabs: newTabs };
		}),

	openNewTab: () =>
		set((state) => {
			// 既存の newtab があればそちらに切り替え
			const existing = state.tabs.find((t) => isNewTabPath(t.path));
			if (existing) {
				return { activeTabPath: existing.path, activeTabId: existing.id };
			}
			const id = state._nextTabId;
			const path = createNewTabPath(id);
			return {
				tabs: [...state.tabs, { id, path, dirty: false, history: [path], historyIndex: 0 }],
				activeTabPath: path,
				activeTabId: id,
				_nextTabId: id + 1,
			};
		}),

	activateNextTab: () => set((state) => activateTabByOffset(state, 1)),

	activatePrevTab: () => set((state) => activateTabByOffset(state, -1)),

	closeTabsByPrefix: (prefix) =>
		set((state) => {
			const activeIndex =
				state.activeTabId != null ? state.tabs.findIndex((t) => t.id === state.activeTabId) : -1;
			const newTabs = state.tabs.filter((t) => !t.path.startsWith(prefix));
			if (newTabs.length === state.tabs.length) return state;

			let newActive: Tab | null =
				state.activeTabId != null
					? (newTabs.find((t) => t.id === state.activeTabId) ?? null)
					: null;

			if (!newActive) {
				if (newTabs.length > 0) {
					const newIndex =
						activeIndex >= 0 ? Math.min(activeIndex, newTabs.length - 1) : newTabs.length - 1;
					newActive = newTabs[newIndex];
				}
			}

			return {
				tabs: newTabs,
				activeTabPath: newActive?.path ?? null,
				activeTabId: newActive?.id ?? null,
			};
		}),
}));
