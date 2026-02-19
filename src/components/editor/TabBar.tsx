import { X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceStore } from "../../stores/workspace";

const isMac = typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

interface TabBarProps {
	onCloseTab: (path: string) => void;
}

export function TabBar({ onCloseTab }: TabBarProps) {
	const { tabs, activeTabPath } = useWorkspaceStore(
		useShallow((s) => ({ tabs: s.tabs, activeTabPath: s.activeTabPath })),
	);
	const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);

	return (
		<div
			className={`flex h-7 shrink-0 border-b border-border bg-bg-primary ${isMac ? "pl-20" : ""}`}
		>
			<div className="flex items-center overflow-x-auto" role="tablist" aria-label="Editor tabs">
				{tabs.map((tab) => {
					const isActive = tab.path === activeTabPath;
					const fileName = tab.path.split(/[\\/]/).pop() ?? tab.path;

					return (
						<div
							key={tab.path}
							title={tab.path}
							role="tab"
							tabIndex={0}
							aria-selected={isActive}
							onClick={() => setActiveTab(tab.path)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									setActiveTab(tab.path);
								}
							}}
							className={`group flex h-full shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 text-xs ${
								isActive
									? "bg-bg-secondary text-text-primary"
									: "text-text-secondary hover:bg-bg-secondary/50"
							}`}
						>
							<span className="flex items-center gap-1.5">
								{tab.dirty && (
									<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-secondary" />
								)}
								{fileName}
							</span>
							<button
								type="button"
								tabIndex={-1}
								aria-label={`Close ${fileName}`}
								onClick={(e) => {
									e.stopPropagation();
									onCloseTab(tab.path);
								}}
								className="rounded p-0.5 opacity-0 hover:bg-black/10 group-hover:opacity-100 dark:hover:bg-white/10"
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
