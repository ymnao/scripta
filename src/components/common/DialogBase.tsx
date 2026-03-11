import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface DialogBaseProps {
	open: boolean;
	onClose: () => void;
	ariaLabelledBy?: string;
	ariaDescribedBy?: string;
	className?: string;
	/** true の間は Escape キーやオーバーレイクリックによる閉じ操作を無効にする */
	preventClose?: boolean;
	children: ReactNode;
}

export function DialogBase({
	open,
	onClose,
	ariaLabelledBy,
	ariaDescribedBy,
	className,
	preventClose,
	children,
}: DialogBaseProps) {
	const dialogRef = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		if (open) {
			dialogRef.current?.focus();
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				if (!preventClose) onClose();
			}
			if (e.key === "Tab") {
				const dialog = dialogRef.current;
				if (!dialog) return;
				const focusable = dialog.querySelectorAll<HTMLElement>(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
				);
				if (focusable.length === 0) return;
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				if (e.shiftKey) {
					if (document.activeElement === first) {
						e.preventDefault();
						last.focus();
					}
				} else {
					if (document.activeElement === last) {
						e.preventDefault();
						first.focus();
					}
				}
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [open, onClose, preventClose]);

	if (!open) return null;

	return createPortal(
		<div
			role="presentation"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
			onMouseDown={preventClose ? undefined : onClose}
		>
			<dialog
				ref={dialogRef}
				open
				aria-modal="true"
				aria-labelledby={ariaLabelledBy}
				aria-describedby={ariaDescribedBy}
				className={`relative mx-4 w-full rounded-lg border border-border bg-bg-primary p-5 shadow-lg outline-none ${className ?? "max-w-sm"}`}
				onMouseDown={(e) => e.stopPropagation()}
				tabIndex={-1}
			>
				{children}
			</dialog>
		</div>,
		document.body,
	);
}
