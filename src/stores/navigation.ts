import { create } from "zustand";

const MAX_HISTORY = 100;

interface NavigationState {
	history: string[];
	historyIndex: number;
	push: (path: string) => void;
	goBack: () => string | null;
	goForward: () => string | null;
	reset: () => void;
	renamePath: (oldPath: string, newPath: string) => void;
	renamePathsByPrefix: (oldPrefix: string, newPrefix: string) => void;
}

export const useNavigationStore = create<NavigationState>()((set, get) => ({
	history: [],
	historyIndex: -1,

	push: (path) =>
		set((state) => {
			if (state.historyIndex >= 0 && state.history[state.historyIndex] === path) {
				return state;
			}
			const trimmed = state.history.slice(0, state.historyIndex + 1);
			const next = [...trimmed, path];
			if (next.length > MAX_HISTORY) {
				next.splice(0, next.length - MAX_HISTORY);
			}
			return { history: next, historyIndex: next.length - 1 };
		}),

	goBack: () => {
		const state = get();
		if (state.historyIndex <= 0) return null;
		const newIndex = state.historyIndex - 1;
		set({ historyIndex: newIndex });
		return state.history[newIndex];
	},

	goForward: () => {
		const state = get();
		if (state.historyIndex >= state.history.length - 1) return null;
		const newIndex = state.historyIndex + 1;
		set({ historyIndex: newIndex });
		return state.history[newIndex];
	},

	reset: () => set({ history: [], historyIndex: -1 }),

	renamePath: (oldPath, newPath) =>
		set((state) => ({
			history: state.history.map((p) => (p === oldPath ? newPath : p)),
		})),

	renamePathsByPrefix: (oldPrefix, newPrefix) =>
		set((state) => ({
			history: state.history.map((p) =>
				p.startsWith(oldPrefix) ? newPrefix + p.slice(oldPrefix.length) : p,
			),
		})),
}));
