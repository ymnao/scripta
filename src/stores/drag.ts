import { create } from "zustand";

interface DragState {
	sourcePath: string | null;
	overPath: string | null;
	setSourcePath: (sourcePath: string | null) => void;
	setOverPath: (overPath: string | null) => void;
	reset: () => void;
}

export const useDragStore = create<DragState>()((set) => ({
	sourcePath: null,
	overPath: null,
	setSourcePath: (sourcePath) => set({ sourcePath }),
	setOverPath: (overPath) => set({ overPath }),
	reset: () => set({ sourcePath: null, overPath: null }),
}));
