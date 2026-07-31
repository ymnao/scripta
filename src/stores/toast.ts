import { create } from "zustand";

export type ToastType = "error" | "warning" | "info" | "success";

// toast が自動で消えるまでの時間。Toast.tsx（表示側）と、失敗通知の連打を抑える
// 側（lib/store.ts の saveSetting）の両方が参照する。抑止窓を表示時間に揃えることで
// 「同じ文言の toast が消える前に次が積まれる」状態を作らないので、定数をここに
// 一本化して片方だけ変えられないようにする。
export const TOAST_AUTO_DISMISS_MS = 5000;

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
