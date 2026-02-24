import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { getFileIcon } from "../../lib/file-icon";
import { useWorkspaceStore } from "../../stores/workspace";

const isMac = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

const DRAG_THRESHOLD = 5;

interface TabBarProps {
	onCloseTab: (id: number) => void;
	onTabSelect: (id: number) => void;
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
	const { tabs, activeTabId } = useWorkspaceStore(
		useShallow((s) => ({ tabs: s.tabs, activeTabId: s.activeTabId })),
	);

	const [dragState, setDragState] = useState<{
		fromIndex: number;
		overIndex: number | null;
		overSide: "left" | "right" | null;
		deltaX: number;
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

	const findDropTarget = useCallback(
		(clientX: number, skipIndex?: number): { index: number; side: "left" | "right" } | null => {
			const tablist = tablistRef.current;
			if (!tablist) return null;
			const tabElements = tablist.querySelectorAll<HTMLElement>("[data-index]");
			for (const el of tabElements) {
				const idx = Number(el.dataset.index);
				if (Number.isNaN(idx) || idx === skipIndex) continue;
				const rect = el.getBoundingClientRect();
				if (clientX >= rect.left && clientX < rect.right) {
					const midX = (rect.left + rect.right) / 2;
					return { index: idx, side: clientX < midX ? "left" : "right" };
				}
			}
			return null;
		},
		[],
	);

	useEffect(() => {
		const handlePointerMove = (e: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag) return;
			const deltaX = e.clientX - drag.startX;
			if (!drag.started && Math.abs(deltaX) > DRAG_THRESHOLD) {
				drag.started = true;
				setDragState({ fromIndex: drag.fromIndex, overIndex: null, overSide: null, deltaX });
			}
			if (drag.started) {
				const target = findDropTarget(e.clientX, drag.fromIndex);
				if (target) {
					setDragState((prev) =>
						prev ? { ...prev, overIndex: target.index, overSide: target.side, deltaX } : null,
					);
				} else {
					setDragState((prev) =>
						prev ? { ...prev, overIndex: null, overSide: null, deltaX } : null,
					);
				}
			}
		};

		const handlePointerUp = (e: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag) return;

			if (drag.started) {
				skipNextClickRef.current = true;
				// Skip the dragged tab itself (its translated rect may overlap targets).
				const targetEl = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
				let dropTarget: { index: number; side: "left" | "right" } | null = null;
				if (targetEl && Number(targetEl.dataset.index) !== drag.fromIndex) {
					const idx = Number(targetEl.dataset.index);
					if (!Number.isNaN(idx)) {
						const rect = targetEl.getBoundingClientRect();
						const midX = (rect.left + rect.right) / 2;
						dropTarget = { index: idx, side: e.clientX < midX ? "left" : "right" };
					}
				}
				if (!dropTarget) {
					dropTarget = findDropTarget(e.clientX, drag.fromIndex);
				}

				if (dropTarget) {
					const { index: targetIndex, side } = dropTarget;
					// Calculate toIndex based on which half of the target tab was dropped on.
					// "left" = insert before target, "right" = insert after target.
					// Account for index shift caused by removing the source tab first.
					let toIndex: number;
					if (side === "left") {
						toIndex = drag.fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
					} else {
						toIndex = drag.fromIndex < targetIndex ? targetIndex : targetIndex + 1;
					}
					if (toIndex !== drag.fromIndex) {
						onReorderTabRef.current(drag.fromIndex, toIndex);
					}
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
	}, [findDropTarget]);

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
				className="flex items-center overflow-x-auto border-l border-border"
				role="tablist"
				aria-label="Editor tabs"
				ref={tablistRef}
			>
				{tabs.map((tab, index) => {
					const isActive = tab.id === activeTabId;
					const fileName = tab.path.split(/[\\/]/).pop() ?? tab.path;
					const isDragging = dragState?.fromIndex === index;
					const isOver = dragState?.overIndex === index;
					const overSide = dragState?.overSide;
					const FileIcon = getFileIcon(fileName);

					return (
						<div
							key={tab.id}
							title={tab.path}
							data-tab-id={tab.id}
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
								onTabSelect(tab.id);
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onTabSelect(tab.id);
								}
								if (e.key === "Delete" || e.key === "Backspace") {
									e.preventDefault();
									onCloseTab(tab.id);
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
									const tabId = next.dataset.tabId;
									if (tabId) onTabSelect(Number(tabId));
								}
								if (e.key === "Home") {
									e.preventDefault();
									const first =
										e.currentTarget.parentElement?.querySelector<HTMLElement>('[role="tab"]');
									if (first) {
										first.focus();
										const tabId = first.dataset.tabId;
										if (tabId) onTabSelect(Number(tabId));
									}
								}
								if (e.key === "End") {
									e.preventDefault();
									const all =
										e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]');
									if (all?.length) {
										const last = all[all.length - 1];
										last.focus();
										const tabId = last.dataset.tabId;
										if (tabId) onTabSelect(Number(tabId));
									}
								}
							}}
							style={
								isDragging && dragState
									? {
											transform: `translateX(${dragState.deltaX}px)`,
											zIndex: 10,
											pointerEvents: "none" as const,
										}
									: undefined
							}
							className={`group relative flex h-full shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 text-xs select-none transition-colors duration-150 ${
								isActive
									? "bg-bg-secondary text-text-primary"
									: "text-text-secondary hover:bg-bg-secondary/50"
							} ${isDragging ? "opacity-50" : ""} ${isOver && overSide === "left" ? "border-l-2 border-l-text-secondary" : ""} ${isOver && overSide === "right" ? "border-r-2 border-r-text-secondary" : ""}`}
						>
							<FileIcon size={14} className="shrink-0 text-text-secondary" />
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
									onCloseTab(tab.id);
								}}
								className="rounded p-0.5 opacity-0 transition-opacity duration-100 hover:bg-black/10 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-white/10"
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
