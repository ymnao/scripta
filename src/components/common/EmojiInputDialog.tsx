import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { isIMEComposing } from "../../lib/ime";
import { DialogBase } from "./DialogBase";
import { EMOJI_CATEGORIES, searchEmojis } from "./emoji-data";

const INITIAL_CATEGORY_COUNT = 3;

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
	const searchRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(currentEmoji ?? "");
	const [query, setQuery] = useState("");
	const [visibleCategory, setVisibleCategory] = useState(EMOJI_CATEGORIES[0].id);
	const [allCategoriesReady, setAllCategoriesReady] = useState(false);

	useEffect(() => {
		if (open) {
			setValue(currentEmoji ?? "");
			setQuery("");
			setVisibleCategory(EMOJI_CATEGORIES[0].id);
			setAllCategoriesReady(false);
			if (scrollRef.current) {
				scrollRef.current.scrollTop = 0;
			}
			requestAnimationFrame(() => {
				searchRef.current?.focus();
				setAllCategoriesReady(true);
			});
		}
	}, [open, currentEmoji]);

	const handleCategoryClick = (id: string) => {
		setAllCategoriesReady(true);
		requestAnimationFrame(() => {
			const heading = scrollRef.current?.querySelector(`[data-category="${id}"]`);
			if (heading) {
				heading.scrollIntoView({ block: "start", behavior: "smooth" });
			}
		});
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

	const handleGridClick = useCallback((e: React.MouseEvent) => {
		const el = (e.target as Element).closest<HTMLElement>("[data-emoji]");
		if (el?.dataset.emoji) {
			setValue(el.dataset.emoji);
		}
	}, []);

	const handleGridKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === "Enter" || e.key === " ") {
			const el = (e.target as Element).closest<HTMLElement>("[data-emoji]");
			if (el?.dataset.emoji) {
				e.preventDefault();
				setValue(el.dataset.emoji);
			}
		}
	}, []);

	const searchResults = useMemo(() => {
		const q = query.trim();
		if (!q) return null;
		return searchEmojis(q);
	}, [query]);

	const isSearching = searchResults !== null;

	return (
		<DialogBase open={open} onClose={onCancel} ariaLabelledBy={titleId} size="md">
			<h2 id={titleId} className="text-sm font-semibold text-text-primary">
				アイコンを設定
			</h2>
			<p className="mt-1 text-xs text-text-secondary truncate">{entryName}</p>

			<div className="mt-3 flex items-center gap-2">
				<input
					ref={searchRef}
					type="text"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (isIMEComposing(e)) return;
						if (e.key === "Enter") {
							e.preventDefault();
							handleSubmit();
						}
					}}
					placeholder="検索..."
					aria-label="絵文字を検索"
					className="min-w-0 flex-1 rounded-md border border-border bg-bg-secondary px-2.5 py-1.5 text-sm text-text-primary outline-none placeholder:text-text-secondary focus:border-blue-500"
				/>
				<div
					className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg-secondary text-xl"
					aria-label="選択中の絵文字"
				>
					{value || <span className="text-xs text-text-secondary">?</span>}
				</div>
			</div>

			{!isSearching && (
				<div className="mt-2 flex border-b border-border">
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
			)}

			<div
				ref={scrollRef}
				aria-label="絵文字一覧"
				className="mt-1 overflow-y-auto"
				style={{ height: "16rem" }}
				onScroll={isSearching ? undefined : handleScroll}
			>
				{isSearching ? (
					searchResults.length > 0 ? (
						<div
							className="grid grid-cols-10 gap-0.5 pt-1"
							onClick={handleGridClick}
							onKeyDown={handleGridKeyDown}
						>
							{searchResults.map((emoji) => (
								<button
									key={emoji}
									type="button"
									data-emoji={emoji}
									aria-label={emoji}
									className={`rounded p-0.5 text-xl leading-none hover:bg-black/10 dark:hover:bg-white/10 ${
										value === emoji ? "bg-black/10 dark:bg-white/10" : ""
									}`}
								>
									{emoji}
								</button>
							))}
						</div>
					) : (
						<p className="py-8 text-center text-xs text-text-secondary">見つかりませんでした</p>
					)
				) : (
					(allCategoriesReady
						? EMOJI_CATEGORIES
						: EMOJI_CATEGORIES.slice(0, INITIAL_CATEGORY_COUNT)
					).map((cat) => (
						<div
							key={cat.id}
							style={{ contentVisibility: "auto", containIntrinsicSize: "auto 200px" }}
						>
							<div
								data-category={cat.id}
								className="sticky top-0 z-10 bg-bg-primary/95 px-0.5 py-1 text-xs text-text-secondary"
							>
								{cat.label}
							</div>
							<div
								className="grid grid-cols-10 gap-0.5"
								onClick={handleGridClick}
								onKeyDown={handleGridKeyDown}
							>
								{cat.emojis.map((emoji) => (
									<button
										key={emoji}
										type="button"
										data-emoji={emoji}
										aria-label={emoji}
										className={`rounded p-0.5 text-xl leading-none hover:bg-black/10 dark:hover:bg-white/10 ${
											value === emoji ? "bg-black/10 dark:bg-white/10" : ""
										}`}
									>
										{emoji}
									</button>
								))}
							</div>
						</div>
					))
				)}
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
