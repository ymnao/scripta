import { create } from "zustand";

export type ToastType = "error" | "warning";

export interface ToastItem {
	id: string;
	type: ToastType;
	message: string;
}

interface ToastState {
	toasts: ToastItem[];
	addToast: (type: ToastType, message: string) => string;
	removeToast: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>()((set) => ({
	toasts: [],
	addToast: (type, message) => {
		const id = `toast-${++nextId}`;
		set((state) => ({ toasts: [...state.toasts, { id, type, message }] }));
		return id;
	},
	removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));
