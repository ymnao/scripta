import { AlertTriangle, CheckCircle, Info, X, XCircle } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { type ToastItem, type ToastType, useToastStore } from "../../stores/toast";

const AUTO_DISMISS_MS = 5000;

const TOAST_STYLES: Record<
	ToastType,
	{
		className: string;
		icon: typeof XCircle;
		role: "alert" | "status";
		live: "assertive" | "polite";
	}
> = {
	error: {
		className:
			"border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
		icon: XCircle,
		role: "alert",
		live: "assertive",
	},
	warning: {
		className:
			"border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200",
		icon: AlertTriangle,
		role: "status",
		live: "polite",
	},
	info: {
		className:
			"border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200",
		icon: Info,
		role: "status",
		live: "polite",
	},
	success: {
		className:
			"border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200",
		icon: CheckCircle,
		role: "status",
		live: "polite",
	},
};

function ToastMessage({ toast }: { toast: ToastItem }) {
	const removeToast = useToastStore((s) => s.removeToast);

	useEffect(() => {
		const timer = setTimeout(() => removeToast(toast.id), AUTO_DISMISS_MS);
		return () => clearTimeout(timer);
	}, [toast.id, removeToast]);

	const style = TOAST_STYLES[toast.type] ?? TOAST_STYLES.info;
	const Icon = style.icon;

	return (
		<div
			role={style.role}
			aria-live={style.live}
			className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 shadow-lg ${style.className}`}
		>
			<Icon size={16} className="mt-0.5 shrink-0" />
			<span className="flex-1 text-sm">{toast.message}</span>
			<button
				type="button"
				aria-label="閉じる"
				className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
				onClick={() => removeToast(toast.id)}
			>
				<X size={14} />
			</button>
		</div>
	);
}

export function ToastContainer() {
	const toasts = useToastStore((s) => s.toasts);

	if (toasts.length === 0) return null;

	return createPortal(
		<div className="fixed right-4 bottom-10 z-50 flex w-80 flex-col gap-2">
			{toasts.map((toast) => (
				<ToastMessage key={toast.id} toast={toast} />
			))}
		</div>,
		document.body,
	);
}
