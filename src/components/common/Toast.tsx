import { AlertTriangle, X, XCircle } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { type ToastItem, useToastStore } from "../../stores/toast";

const AUTO_DISMISS_MS = 5000;

function ToastMessage({ toast }: { toast: ToastItem }) {
	const removeToast = useToastStore((s) => s.removeToast);

	useEffect(() => {
		const timer = setTimeout(() => removeToast(toast.id), AUTO_DISMISS_MS);
		return () => clearTimeout(timer);
	}, [toast.id, removeToast]);

	const isError = toast.type === "error";

	return (
		<div
			role="alert"
			aria-live="polite"
			className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 shadow-lg ${
				isError
					? "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
					: "border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-200"
			}`}
		>
			{isError ? (
				<XCircle size={16} className="mt-0.5 shrink-0" />
			) : (
				<AlertTriangle size={16} className="mt-0.5 shrink-0" />
			)}
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
