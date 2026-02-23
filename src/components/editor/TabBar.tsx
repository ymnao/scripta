import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceStore } from "../../stores/workspace";

const isMac = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

const DRAG_THRESHOLD = 5;

interface TabBarProps {
	onCloseTab: (path: string) => void;
	onTabSelect: (path: string) => void;
	canGoBack: boolean;
	canGoForward: boolean;
	onGoBack: () => void;
	onGoForward: () => void;
	onReorderTab: (fromIndex: number, toIndex: number) => void;
}

export function TabBar({
	onCloseTab,
	onTabSelect,
	canGoBack,
	canGoForward,
	onGoBack,
	onGoForward,
	onReorderTab,
}: TabBarProps) {
	const { tabs, activeTabPath } = useWorkspaceStore(
		useShallow((s) => ({ tabs: s.tabs, activeTabPath: s.activeTabPath })),
	);

	const [dragState, setDragState] = useState<{
		fromIndex: number;
		overIndex: number | null;
	} | null>(null);
	const dragRef = useRef<{
		fromIndex: number;
		startX: number;
		started: boolean;
	} | null>(null);
	const skipNextClickRef = useRef(false);
	const tablistRef = useRef<HTMLDivElement>(null);

	const onReorderTabRef = useRef(onReorderTab);
	onReorderTabRef.current = onReorderTab;

	const findTabIndexAt = useCallback((clientX: number): number | null => {
		const tablist = tablistRef.current;
		if (!tablist) return null;
		const tabElements = tablist.querySelectorAll<HTMLElement>("[data-index]");
		for (const el of tabElements) {
			const rect = el.getBoundingClientRect();
			if (clientX >= rect.left && clientX < rect.right) {
				const idx = Number(el.dataset.index);
				return Number.isNaN(idx) ? null : idx;
			}
		}
		return null;
	}, []);

	useEffect(() => {
		const handlePointerMove = (e: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag) return;
			if (!drag.started && Math.abs(e.clientX - drag.startX) > DRAG_THRESHOLD) {
				drag.started = true;
				setDragState({ fromIndex: drag.fromIndex, overIndex: null });
			}
			if (drag.started) {
				const overIndex = findTabIndexAt(e.clientX);
				setDragState((prev) =>
					prev ? { ...prev, overIndex: overIndex !== drag.fromIndex ? overIndex : null } : null,
				);
			}
		};

		const handlePointerUp = (e: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag) return;

			if (drag.started) {
				skipNextClickRef.current = true;
				// Determine drop target: first try e.target (works when released over a tab),
				// then fall back to coordinate-based lookup.
				const targetEl = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
				const toIndex = targetEl ? Number(targetEl.dataset.index) : findTabIndexAt(e.clientX);
				if (toIndex != null && !Number.isNaN(toIndex) && toIndex !== drag.fromIndex) {
					onReorderTabRef.current(drag.fromIndex, toIndex);
				}
			}

			dragRef.current = null;
			setDragState(null);
		};

		document.addEventListener("pointermove", handlePointerMove);
		document.addEventListener("pointerup", handlePointerUp);
		return () => {
			document.removeEventListener("pointermove", handlePointerMove);
			document.removeEventListener("pointerup", handlePointerUp);
		};
	}, [findTabIndexAt]);

	return (
		<div
			className={`flex h-7 shrink-0 border-b border-border bg-bg-primary ${isMac ? "pl-20" : ""}`}
		>
			<div className="flex shrink-0 items-center gap-0.5 px-1">
				<button
					type="button"
					onClick={onGoBack}
					disabled={!canGoBack}
					aria-label="戻る"
					className={`rounded p-0.5 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary dark:hover:bg-white/10 ${!canGoBack ? "opacity-30" : ""}`}
				>
					<ChevronLeft size={14} />
				</button>
				<button
					type="button"
					onClick={onGoForward}
					disabled={!canGoForward}
					aria-label="進む"
					className={`rounded p-0.5 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary dark:hover:bg-white/10 ${!canGoForward ? "opacity-30" : ""}`}
				>
					<ChevronRight size={14} />
				</button>
			</div>
			<div
				className="flex items-center overflow-x-auto"
				role="tablist"
				aria-label="Editor tabs"
				ref={tablistRef}
			>
				{tabs.map((tab, index) => {
					const isActive = tab.path === activeTabPath;
					const fileName = tab.path.split(/[\\/]/).pop() ?? tab.path;

					return (
						<div
							key={tab.path}
							title={tab.path}
							data-path={tab.path}
							data-index={index}
							role="tab"
							tabIndex={isActive ? 0 : -1}
							aria-selected={isActive}
							aria-label={tab.dirty ? `${fileName}, unsaved changes` : undefined}
							onPointerDown={(e) => {
								if ((e.target as HTMLElement).closest("button")) return;
								if (e.button !== 0) return;
								dragRef.current = { fromIndex: index, startX: e.clientX, started: false };
							}}
							onClick={() => {
								if (skipNextClickRef.current) {
									skipNextClickRef.current = false;
									return;
								}
								onTabSelect(tab.path);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onTabSelect(tab.path);
								}
								if (e.key === "Delete" || e.key === "Backspace") {
									e.preventDefault();
									onCloseTab(tab.path);
								}
								if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
									e.preventDefault();
									const tabElements =
										e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
									if (!tabElements) return;
									const currentIndex = Array.from(tabElements).indexOf(
										e.currentTarget as HTMLElement,
									);
									const nextIndex =
										e.key === "ArrowRight"
											? (currentIndex + 1) % tabElements.length
											: (currentIndex - 1 + tabElements.length) % tabElements.length;
									const next = tabElements[nextIndex];
									next.focus();
									if (next.dataset.path) onTabSelect(next.dataset.path);
								}
								if (e.key === "Home") {
									e.preventDefault();
									const first =
										e.currentTarget.parentElement?.querySelector<HTMLElement>('[role="tab"]');
									if (first) {
										first.focus();
										if (first.dataset.path) onTabSelect(first.dataset.path);
									}
								}
								if (e.key === "End") {
									e.preventDefault();
									const all =
										e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
									if (all?.length) {
										const last = all[all.length - 1];
										last.focus();
										if (last.dataset.path) onTabSelect(last.dataset.path);
									}
								}
							}}
							className={`group flex h-full shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 text-xs select-none ${
								isActive
									? "bg-bg-secondary text-text-primary"
									: "text-text-secondary hover:bg-bg-secondary/50"
							} ${dragState?.fromIndex === index ? "opacity-50" : ""} ${dragState?.overIndex === index ? "border-l-2 border-l-text-secondary" : ""}`}
						>
							<span className="flex items-center gap-1.5">
								{tab.dirty && (
									<span
										className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary"
										aria-hidden="true"
									/>
								)}
								{fileName}
							</span>
							<button
								type="button"
								aria-label={`Close ${fileName}`}
								onClick={(e) => {
									e.stopPropagation();
									onCloseTab(tab.path);
								}}
								className="rounded p-0.5 opacity-0 hover:bg-black/10 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-white/10"
							>
								<X size={12} />
							</button>
						</div>
					);
				})}
			</div>
			<div data-tauri-drag-region className="flex-1" />
		</div>
	);
}
