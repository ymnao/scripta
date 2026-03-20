import { create } from "zustand";

interface DragState {
	sourcePath: string | null;
	overPath: string | null;
	hoverPath: string | null;
	setSourcePath: (sourcePath: string | null) => void;
	setDragOver: (overPath: string | null, hoverPath: string | null) => void;
	reset: () => void;
}

export const useDragStore = create<DragState>()((set) => ({
	sourcePath: null,
	overPath: null,
	hoverPath: null,
	setSourcePath: (sourcePath) => set({ sourcePath }),
	setDragOver: (overPath, hoverPath) => set({ overPath, hoverPath }),
	reset: () => set({ sourcePath: null, overPath: null, hoverPath: null }),
}));
