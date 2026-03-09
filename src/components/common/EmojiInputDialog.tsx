import { useEffect, useId, useRef, useState } from "react";
import { DialogBase } from "./DialogBase";

interface EmojiInputDialogProps {
	open: boolean;
	currentEmoji: string | null;
	entryName: string;
	onConfirm: (emoji: string) => void;
	onRemove: () => void;
	onCancel: () => void;
}

export function EmojiInputDialog({
	open,
	currentEmoji,
	entryName,
	onConfirm,
	onRemove,
	onCancel,
}: EmojiInputDialogProps) {
	const titleId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(currentEmoji ?? "");

	useEffect(() => {
		if (open) {
			setValue(currentEmoji ?? "");
			requestAnimationFrame(() => {
				inputRef.current?.focus();
				inputRef.current?.select();
			});
		}
	}, [open, currentEmoji]);

	const handleSubmit = () => {
		const trimmed = value.trim();
		if (trimmed) {
			onConfirm(trimmed);
		}
	};

	return (
		<DialogBase open={open} onClose={onCancel} ariaLabelledBy={titleId}>
			<h2 id={titleId} className="text-sm font-semibold text-text-primary">
				アイコンを設定
			</h2>
			<p className="mt-1 text-xs text-text-secondary truncate">{entryName}</p>
			<div className="mt-4 flex justify-center">
				<input
					ref={inputRef}
					type="text"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							handleSubmit();
						}
					}}
					className="w-16 rounded-md border border-border bg-bg-secondary p-2 text-center text-2xl outline-none focus:border-blue-500"
					aria-label="絵文字を入力"
				/>
			</div>
			<div className="mt-4 flex justify-between">
				<div>
					{currentEmoji && (
						<button
							type="button"
							className="rounded px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
							onClick={onRemove}
						>
							削除
						</button>
					)}
				</div>
				<div className="flex gap-2">
					<button
						type="button"
						className="rounded px-3 py-1.5 text-sm text-text-secondary hover:bg-black/5 dark:hover:bg-white/5"
						onClick={onCancel}
					>
						キャンセル
					</button>
					<button
						type="button"
						className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
						disabled={!value.trim()}
						onClick={handleSubmit}
					>
						設定
					</button>
				</div>
			</div>
		</DialogBase>
	);
}
