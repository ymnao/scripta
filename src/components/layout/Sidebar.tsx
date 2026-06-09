import { Files, FolderOpen, Link2Off, Search } from "lucide-react";
import { useCallback } from "react";
import { openDirectoryPicker, workspaceSet } from "../../lib/commands";
import { translateError } from "../../lib/errors";
import { useToastStore } from "../../stores/toast";
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
	onSearchNavigate: (
		filePath: string,
		lineNumber: number,
		query: string,
		matchStart?: number,
		matchEnd?: number,
	) => void;
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
		const selected = await openDirectoryPicker();
		if (!selected) return;
		try {
			// fs:* IPC が走り出す前に main 側 workspace 登録を完了させる必要がある
			// （FileTree などが setWorkspacePath をトリガーに即 listDirectory を打つため）
			await workspaceSet(selected);
			setWorkspacePath(selected);
		} catch (error) {
			// main 側 reject（未承認 path / settings 永続化失敗 / Permission denied 等）を
			// silently 握りつぶさず、ユーザーに通知する。
			// workspace:set は atomic（永続化が成功した後にのみ allowedRoots を更新）
			// なので、失敗時は main 側 state が変化していない。ここで workspaceSet(null) を
			// 呼ぶと、既存 workspace が開かれていた場合にそれまで誤って巻き戻してしまうため、
			// ロールバックは行わず既存状態を維持する。
			console.error("Failed to open folder:", error);
			useToastStore
				.getState()
				.addToast("error", `フォルダを開けませんでした: ${translateError(error)}`);
		}
	}, [setWorkspacePath]);

	const iconBtnClass = (active: boolean) =>
		`rounded p-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary ${active ? "text-text-primary" : "text-text-secondary hover:bg-black/10 dark:hover:bg-white/10"}`;

	return (
		<aside className="flex w-60 shrink-0 flex-col bg-bg-primary text-text-primary">
			<div className="flex items-center justify-between p-3 text-xs font-semibold uppercase tracking-wider text-text-secondary">
				<span>{panelLabels[activePanel]}</span>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onShowFiles}
						aria-label="ファイルエクスプローラーを表示"
						aria-pressed={activePanel === "files"}
						className={iconBtnClass(activePanel === "files")}
					>
						<Files size={14} />
					</button>
					<button
						type="button"
						onClick={onShowSearch}
						aria-label="ワークスペース内を検索"
						aria-pressed={activePanel === "search"}
						className={iconBtnClass(activePanel === "search")}
					>
						<Search size={14} />
					</button>
					<button
						type="button"
						onClick={onShowUnresolved}
						aria-label="未解決リンクを表示"
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
						<p className="text-center text-xs text-text-secondary">フォルダを開いて始めましょう</p>
						<button
							type="button"
							onClick={handleOpenFolder}
							aria-label="フォルダを開く"
							className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text-primary hover:bg-bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary"
						>
							<FolderOpen size={14} />
							フォルダを開く
						</button>
					</div>
				)}
			</div>
		</aside>
	);
}
