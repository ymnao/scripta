import { useCallback, useEffect, useId, useRef, useState } from "react";
import { DialogBase } from "./DialogBase";
import { EMOJI_CATEGORIES } from "./emoji-data";

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
	const scrollRef = useRef<HTMLDivElement>(null);
	const [value, setValue] = useState(currentEmoji ?? "");
	const [visibleCategory, setVisibleCategory] = useState(EMOJI_CATEGORIES[0].id);

	useEffect(() => {
		if (open) {
			setValue(currentEmoji ?? "");
			setVisibleCategory(EMOJI_CATEGORIES[0].id);
			if (scrollRef.current) {
				scrollRef.current.scrollTop = 0;
			}
		}
	}, [open, currentEmoji]);

	const handleCategoryClick = (id: string) => {
		const heading = scrollRef.current?.querySelector(`[data-category="${id}"]`);
		if (heading) {
			heading.scrollIntoView({ block: "start", behavior: "smooth" });
		}
	};

	const handleScroll = useCallback(() => {
		const container = scrollRef.current;
		if (!container) return;
		const scrollTop = container.scrollTop;
		const headings = container.querySelectorAll<HTMLElement>("[data-category]");
		let current = EMOJI_CATEGORIES[0].id;
		for (const heading of headings) {
			if (heading.offsetTop <= scrollTop + 4) {
				current = heading.dataset.category ?? current;
			} else {
				break;
			}
		}
		setVisibleCategory(current);
	}, []);

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

			<div className="mt-3 flex justify-center">
				<div
					className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-bg-secondary text-2xl"
					aria-label="選択中の絵文字"
				>
					{value || <span className="text-sm text-text-secondary">?</span>}
				</div>
			</div>

			<div className="mt-3 flex border-b border-border">
				{EMOJI_CATEGORIES.map((cat) => (
					<button
						key={cat.id}
						type="button"
						title={cat.label}
						aria-label={cat.label}
						className={`flex-1 py-1.5 text-center text-sm transition-colors ${
							visibleCategory === cat.id
								? "border-b-2 border-text-primary"
								: "text-text-secondary hover:bg-black/5 dark:hover:bg-white/5"
						}`}
						onClick={() => handleCategoryClick(cat.id)}
					>
						{cat.icon}
					</button>
				))}
			</div>

			<div
				ref={scrollRef}
				aria-label="絵文字一覧"
				className="mt-1 overflow-y-auto"
				style={{ height: "11rem" }}
				onScroll={handleScroll}
			>
				{EMOJI_CATEGORIES.map((cat) => (
					<div key={cat.id}>
						<div
							data-category={cat.id}
							className="sticky top-0 z-10 bg-bg-primary/95 px-0.5 py-1 text-xs text-text-secondary"
						>
							{cat.label}
						</div>
						<div className="grid grid-cols-8 gap-0.5">
							{cat.emojis.map((emoji) => (
								<button
									key={emoji}
									type="button"
									aria-label={emoji}
									className={`rounded p-0.5 text-xl leading-none hover:bg-black/10 dark:hover:bg-white/10 ${
										value === emoji ? "bg-black/10 dark:bg-white/10" : ""
									}`}
									onClick={() => setValue(emoji)}
								>
									{emoji}
								</button>
							))}
						</div>
					</div>
				))}
			</div>

			<div className="mt-3 flex justify-between">
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
