import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceStore } from "../../stores/workspace";

const isMac = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

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

	const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
	const draggingIndexRef = useRef<number | null>(null);
	const [dropIndex, setDropIndex] = useState<number | null>(null);

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
			<div className="flex items-center overflow-x-auto" role="tablist" aria-label="Editor tabs">
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
							draggable
							onDragStart={(e) => {
								draggingIndexRef.current = index;
								setDraggingIndex(index);
								e.dataTransfer.effectAllowed = "move";
								e.dataTransfer.setData("text/plain", tab.path);
							}}
							onDragOver={(e) => {
								e.preventDefault();
								e.dataTransfer.dropEffect = "move";
								setDropIndex(index);
							}}
							onDragLeave={() => {
								setDropIndex((prev) => (prev === index ? null : prev));
							}}
							onDrop={(e) => {
								e.preventDefault();
								const from = draggingIndexRef.current;
								if (from != null && from !== index) {
									onReorderTab(from, index);
								}
								draggingIndexRef.current = null;
								setDraggingIndex(null);
								setDropIndex(null);
							}}
							onDragEnd={() => {
								draggingIndexRef.current = null;
								setDraggingIndex(null);
								setDropIndex(null);
							}}
							onClick={() => onTabSelect(tab.path)}
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
							className={`group flex h-full shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 text-xs ${
								isActive
									? "bg-bg-secondary text-text-primary"
									: "text-text-secondary hover:bg-bg-secondary/50"
							} ${draggingIndex === index ? "opacity-50" : ""} ${dropIndex === index && draggingIndex !== index ? "border-l-2 border-l-text-secondary" : ""}`}
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
