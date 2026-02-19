import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { useCallback } from "react";
import { useWorkspaceStore } from "../../stores/workspace";
import { FileTree } from "../filetree/FileTree";

export function Sidebar() {
	const workspacePath = useWorkspaceStore((s) => s.workspacePath);
	const setWorkspacePath = useWorkspaceStore((s) => s.setWorkspacePath);
	const openFilePath = useWorkspaceStore((s) => s.openFilePath);
	const setOpenFilePath = useWorkspaceStore((s) => s.setOpenFilePath);

	const handleOpenFolder = useCallback(async () => {
		const selected = await open({ directory: true });
		if (selected) {
			setWorkspacePath(selected);
		}
	}, [setWorkspacePath]);

	return (
		<aside className="flex w-60 shrink-0 flex-col border-r border-border bg-bg-primary text-text-primary">
			<div className="flex items-center justify-between p-3 text-xs font-semibold uppercase tracking-wider text-text-secondary">
				<span>Files</span>
				<button
					type="button"
					onClick={handleOpenFolder}
					aria-label="Open folder"
					className="rounded p-0.5 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary dark:hover:bg-white/10"
				>
					<FolderOpen size={14} />
				</button>
			</div>
			<div className="flex-1 overflow-y-auto">
				{workspacePath ? (
					<FileTree
						workspacePath={workspacePath}
						selectedPath={openFilePath}
						onFileSelect={setOpenFilePath}
					/>
				) : (
					<p className="px-3 py-2 text-xs text-text-secondary">Open a folder to get started</p>
				)}
			</div>
		</aside>
	);
}
