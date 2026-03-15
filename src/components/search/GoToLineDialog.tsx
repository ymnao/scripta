import { useCallback, useEffect, useRef, useState } from "react";

interface GoToLineDialogProps {
	open: boolean;
	totalLines: number;
	onGoToLine: (line: number) => void;
	onClose: () => void;
}

export function GoToLineDialog({ open, totalLines, onGoToLine, onClose }: GoToLineDialogProps) {
	const [value, setValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (open) {
			setValue("");
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				e.preventDefault();
				onClose();
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [open, onClose]);

	const handleSubmit = useCallback(() => {
		const line = Number.parseInt(value, 10);
		if (Number.isNaN(line) || line < 1) return;
		onGoToLine(Math.min(line, totalLines));
		onClose();
	}, [value, totalLines, onGoToLine, onClose]);

	if (!open) return null;

	return (
		<div className="absolute top-0 right-0 left-0 z-20 flex justify-center pt-2">
			<div className="flex items-center gap-2 rounded-lg border border-border bg-bg-primary px-3 py-2 shadow-lg">
				<label htmlFor="go-to-line-input" className="text-xs text-text-secondary">
					行番号:
				</label>
				<input
					ref={inputRef}
					id="go-to-line-input"
					type="text"
					inputMode="numeric"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							handleSubmit();
						}
					}}
					placeholder={`1–${totalLines}`}
					className="w-20 rounded border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary outline-none focus:border-blue-500"
				/>
				<span className="text-[10px] text-text-secondary/60">/ {totalLines}</span>
			</div>
		</div>
	);
}
