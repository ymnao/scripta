import { create } from "zustand";

interface ScratchpadState {
	open: boolean;
	toggle: () => void;
	setOpen: (open: boolean) => void;
}

export const useScratchpadStore = create<ScratchpadState>()((set) => ({
	open: false,
	toggle: () => {
		set((state) => ({ open: !state.open }));
	},
	setOpen: (open: boolean) => {
		set({ open });
	},
}));
