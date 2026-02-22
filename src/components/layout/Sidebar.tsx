import { open } from "@tauri-apps/plugin-dialog";
import { Files, FolderOpen, Search } from "lucide-react";
import { useCallback } from "react";
import { useWorkspaceStore } from "../../stores/workspace";
import { FileTree } from "../filetree/FileTree";
import { SearchPanel } from "../search/SearchPanel";

interface SidebarProps {
	searchActive: boolean;
	onShowFiles: () => void;
	onShowSearch: () => void;
	onSearchNavigate: (filePath: string, lineNumber: number, query: string) => void;
	searchInputRef?: React.RefObject<HTMLInputElement | null>;
	onFileRenamed?: (oldPath: string, newPath: string, isDirectory: boolean) => void;
	onFileDeleted?: (path: string, isDirectory: boolean) => void;
}

export function Sidebar({
	searchActive,
	onShowFiles,
	onShowSearch,
	onSearchNavigate,
	searchInputRef,
	onFileRenamed,
	onFileDeleted,
}: SidebarProps) {
	const workspacePath = useWorkspaceStore((s) => s.workspacePath);
	const setWorkspacePath = useWorkspaceStore((s) => s.setWorkspacePath);
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);
	const openTab = useWorkspaceStore((s) => s.openTab);

	const handleOpenFolder = useCallback(async () => {
		const selected = await open({ directory: true });
		if (selected) {
			setWorkspacePath(selected);
		}
	}, [setWorkspacePath]);

	return (
		<aside className="flex w-60 shrink-0 flex-col border-r border-border bg-bg-primary text-text-primary">
			<div className="flex items-center justify-between p-3 text-xs font-semibold uppercase tracking-wider text-text-secondary">
				<span>{searchActive ? "Search" : "Files"}</span>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onShowFiles}
						aria-label="Show file explorer"
						aria-pressed={!searchActive}
						className={`rounded p-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary ${!searchActive ? "text-text-primary" : "text-text-secondary hover:bg-black/10 dark:hover:bg-white/10"}`}
					>
						<Files size={14} />
					</button>
					<button
						type="button"
						onClick={onShowSearch}
						aria-label="Search in workspace"
						aria-pressed={searchActive}
						className={`rounded p-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary ${searchActive ? "text-text-primary" : "text-text-secondary hover:bg-black/10 dark:hover:bg-white/10"}`}
					>
						<Search size={14} />
					</button>
				</div>
			</div>
			<div className="flex-1 overflow-y-auto">
				{searchActive && workspacePath ? (
					<SearchPanel
						workspacePath={workspacePath}
						onNavigate={onSearchNavigate}
						inputRef={searchInputRef}
					/>
				) : workspacePath ? (
					<FileTree
						workspacePath={workspacePath}
						selectedPath={activeTabPath}
						onFileSelect={openTab}
						onFileRenamed={onFileRenamed}
						onFileDeleted={onFileDeleted}
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
