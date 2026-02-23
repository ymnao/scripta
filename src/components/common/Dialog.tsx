import { useEffect, useId, useRef } from "react";
import { DialogBase } from "./DialogBase";

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
	const titleId = useId();
	const descId = useId();

	useEffect(() => {
		if (open) {
			confirmRef.current?.focus();
		}
	}, [open]);

	return (
		<DialogBase open={open} onClose={onCancel} ariaLabelledBy={titleId} ariaDescribedBy={descId}>
			<h2 id={titleId} className="text-sm font-semibold text-text-primary">
				{title}
			</h2>
			<p id={descId} className="mt-2 text-sm text-text-secondary">
				{description}
			</p>
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
		</DialogBase>
	);
}
