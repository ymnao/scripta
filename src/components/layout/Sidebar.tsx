import { open } from "@tauri-apps/plugin-dialog";
import { Files, FolderOpen, Link2Off, Search } from "lucide-react";
import { useCallback } from "react";
import { useWorkspaceStore } from "../../stores/workspace";
import { FileTree } from "../filetree/FileTree";
import { SearchPanel } from "../search/SearchPanel";
import { UnresolvedLinksPanel } from "../search/UnresolvedLinksPanel";

export type SidebarPanel = "files" | "search" | "unresolved";

interface SidebarProps {
	activePanel: SidebarPanel;
	onShowFiles: () => void;
	onShowSearch: () => void;
	onShowUnresolved: () => void;
	onSearchNavigate: (filePath: string, lineNumber: number, query: string) => void;
	onFileSelect: (path: string) => void;
	onFileOpenNewTab: (path: string) => void;
	searchInputRef?: React.RefObject<HTMLInputElement | null>;
	onFileRenamed?: (oldPath: string, newPath: string, isDirectory: boolean) => void;
	onFileDeleted?: (path: string, isDirectory: boolean) => void;
	onExport?: (path: string) => void;
}

const panelLabels: Record<SidebarPanel, string> = {
	files: "Files",
	search: "Search",
	unresolved: "未解決リンク",
};

export function Sidebar({
	activePanel,
	onShowFiles,
	onShowSearch,
	onShowUnresolved,
	onSearchNavigate,
	onFileSelect,
	onFileOpenNewTab,
	searchInputRef,
	onFileRenamed,
	onFileDeleted,
	onExport,
}: SidebarProps) {
	const workspacePath = useWorkspaceStore((s) => s.workspacePath);
	const setWorkspacePath = useWorkspaceStore((s) => s.setWorkspacePath);
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);

	const handleOpenFolder = useCallback(async () => {
		const selected = await open({ directory: true });
		if (selected) {
			setWorkspacePath(selected);
		}
	}, [setWorkspacePath]);

	const iconBtnClass = (active: boolean) =>
		`rounded p-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary ${active ? "text-text-primary" : "text-text-secondary hover:bg-black/10 dark:hover:bg-white/10"}`;

	return (
		<aside className="flex w-60 shrink-0 flex-col border-r border-border bg-bg-primary text-text-primary">
			<div className="flex items-center justify-between p-3 text-xs font-semibold uppercase tracking-wider text-text-secondary">
				<span>{panelLabels[activePanel]}</span>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onShowFiles}
						aria-label="Show file explorer"
						aria-pressed={activePanel === "files"}
						className={iconBtnClass(activePanel === "files")}
					>
						<Files size={14} />
					</button>
					<button
						type="button"
						onClick={onShowSearch}
						aria-label="Search in workspace"
						aria-pressed={activePanel === "search"}
						className={iconBtnClass(activePanel === "search")}
					>
						<Search size={14} />
					</button>
					<button
						type="button"
						onClick={onShowUnresolved}
						aria-label="Show unresolved wikilinks"
						aria-pressed={activePanel === "unresolved"}
						className={iconBtnClass(activePanel === "unresolved")}
					>
						<Link2Off size={14} />
					</button>
				</div>
			</div>
			<div className="flex-1 overflow-y-auto">
				{activePanel === "search" && workspacePath ? (
					<SearchPanel
						workspacePath={workspacePath}
						onNavigate={onSearchNavigate}
						inputRef={searchInputRef}
					/>
				) : activePanel === "unresolved" && workspacePath ? (
					<UnresolvedLinksPanel workspacePath={workspacePath} onNavigate={onSearchNavigate} />
				) : workspacePath ? (
					<FileTree
						workspacePath={workspacePath}
						selectedPath={activeTabPath}
						onFileSelect={onFileSelect}
						onFileOpenNewTab={onFileOpenNewTab}
						onFileRenamed={onFileRenamed}
						onFileDeleted={onFileDeleted}
						onExport={onExport}
					/>
				) : (
					<div className="flex flex-col items-center gap-3 px-4 py-8">
						<p className="text-center text-xs text-text-secondary">Open a folder to get started</p>
						<button
							type="button"
							onClick={handleOpenFolder}
							aria-label="Open folder"
							className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text-primary hover:bg-bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary"
						>
							<FolderOpen size={14} />
							Open Folder
						</button>
					</div>
				)}
			</div>
		</aside>
	);
}
