import { create } from "zustand";

interface WorkspaceState {
	workspacePath: string | null;
	openFilePath: string | null;
	setWorkspacePath: (path: string | null) => void;
	setOpenFilePath: (path: string | null) => void;
}

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
	workspacePath: null,
	openFilePath: null,
	setWorkspacePath: (path) => set({ workspacePath: path, openFilePath: null }),
	setOpenFilePath: (path) => set({ openFilePath: path }),
}));
