import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface DialogProps {
	open: boolean;
	title: string;
	description: string;
	confirmLabel?: string;
	cancelLabel?: string;
	variant?: "default" | "danger";
	onConfirm: () => void;
	onCancel: () => void;
}

export function Dialog({
	open,
	title,
	description,
	confirmLabel = "Confirm",
	cancelLabel = "Cancel",
	variant = "default",
	onConfirm,
	onCancel,
}: DialogProps) {
	const confirmRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (open) {
			confirmRef.current?.focus();
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				onCancel();
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [open, onCancel]);

	if (!open) return null;

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onClick={onCancel}
			onKeyDown={(e) => {
				if (e.key === "Escape") onCancel();
			}}
		>
			<dialog
				open
				aria-modal="true"
				className="mx-4 w-full max-w-sm rounded-lg border border-border bg-bg-primary p-5 shadow-lg"
				onClick={(e) => e.stopPropagation()}
				onKeyDown={(e) => e.stopPropagation()}
			>
				<h2 className="text-sm font-semibold text-text-primary">{title}</h2>
				<p className="mt-2 text-sm text-text-secondary">{description}</p>
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						className="rounded px-3 py-1.5 text-sm text-text-secondary hover:bg-black/5 dark:hover:bg-white/5"
						onClick={onCancel}
					>
						{cancelLabel}
					</button>
					<button
						ref={confirmRef}
						type="button"
						className={`rounded px-3 py-1.5 text-sm font-medium text-white ${
							variant === "danger" ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
						}`}
						onClick={onConfirm}
					>
						{confirmLabel}
					</button>
				</div>
			</dialog>
		</div>,
		document.body,
	);
}
