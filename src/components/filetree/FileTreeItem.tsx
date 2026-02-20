import { AlertTriangle, ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listDirectory } from "../../lib/commands";
import type { FileEntry } from "../../types/workspace";
import { InlineInput } from "./InlineInput";

interface CreatingState {
	parentPath: string;
	type: "file" | "folder";
}

interface FileTreeItemProps {
	entry: FileEntry;
	depth: number;
	selectedPath: string | null;
	onFileSelect: (path: string) => void;
	refreshKey: number;
	creating: CreatingState | null;
	renamingPath: string | null;
	onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
	onRenameConfirm: (newName: string) => void;
	onCreateConfirm: (name: string) => void;
	onRenameCancel: () => void;
	onCreateCancel: () => void;
}

export function FileTreeItem({
	entry,
	depth,
	selectedPath,
	onFileSelect,
	refreshKey,
	creating,
	renamingPath,
	onContextMenu,
	onRenameConfirm,
	onCreateConfirm,
	onRenameCancel,
	onCreateCancel,
}: FileTreeItemProps) {
	const [expanded, setExpanded] = useState(false);
	const [children, setChildren] = useState<FileEntry[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState(false);
	const isMountedRef = useRef(true);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const isSelected = entry.path === selectedPath;
	const isRenaming = entry.path === renamingPath;
	const isCreatingHere = creating?.parentPath === entry.path && entry.isDirectory;

	// Auto-expand folder when creating inside it
	useEffect(() => {
		if (isCreatingHere && !expanded) {
			if (!loaded && !loading) {
				setLoading(true);
				setLoadError(false);
				listDirectory(entry.path)
					.then((entries) => {
						if (!isMountedRef.current) return;
						setChildren(entries);
						setLoaded(true);
						setExpanded(true);
					})
					.catch((err) => {
						if (!isMountedRef.current) return;
						console.error("Failed to list directory:", err);
						setLoadError(true);
					})
					.finally(() => {
						if (!isMountedRef.current) return;
						setLoading(false);
					});
			} else if (loaded) {
				setExpanded(true);
			}
		}
	}, [isCreatingHere, expanded, loaded, loading, entry.path]);

	// Re-fetch children when refreshKey changes (for expanded folders)
	const prevRefreshKeyRef = useRef(refreshKey);
	useEffect(() => {
		if (prevRefreshKeyRef.current === refreshKey) return;
		prevRefreshKeyRef.current = refreshKey;
		if (!entry.isDirectory || !expanded || !loaded) return;
		let ignore = false;
		listDirectory(entry.path)
			.then((entries) => {
				if (ignore || !isMountedRef.current) return;
				setChildren(entries);
			})
			.catch((err) => {
				if (ignore || !isMountedRef.current) return;
				console.error("Failed to refresh directory:", err);
			});
		return () => {
			ignore = true;
		};
	}, [refreshKey, entry.isDirectory, entry.path, expanded, loaded]);

	const handleClick = useCallback(() => {
		if (entry.isDirectory) {
			if ((!loaded || loadError) && !loading) {
				setLoading(true);
				setLoadError(false);
				listDirectory(entry.path)
					.then((entries) => {
						if (!isMountedRef.current) return;
						setChildren(entries);
						setLoaded(true);
						setExpanded(true);
					})
					.catch((err) => {
						if (!isMountedRef.current) return;
						console.error("Failed to list directory:", err);
						setLoadError(true);
					})
					.finally(() => {
						if (!isMountedRef.current) return;
						setLoading(false);
					});
			} else if (loaded) {
				setExpanded((prev) => !prev);
			}
		} else {
			onFileSelect(entry.path);
		}
	}, [entry.isDirectory, entry.path, loaded, loadError, loading, onFileSelect]);

	const handleContextMenuEvent = useCallback(
		(e: React.MouseEvent) => {
			onContextMenu(e, entry);
		},
		[onContextMenu, entry],
	);

	if (isRenaming) {
		return (
			<li>
				<InlineInput
					depth={depth}
					defaultValue={entry.name}
					icon={entry.isDirectory ? "folder" : "file"}
					onConfirm={onRenameConfirm}
					onCancel={onRenameCancel}
				/>
			</li>
		);
	}

	return (
		<li>
			<button
				type="button"
				aria-label={`${entry.name} ${entry.isDirectory ? "folder" : "file"}`}
				aria-expanded={entry.isDirectory ? expanded : undefined}
				aria-selected={isSelected || undefined}
				className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 ${isSelected ? "bg-black/10 dark:bg-white/10" : ""}`}
				style={{ paddingLeft: `${depth * 16 + 4}px` }}
				onClick={handleClick}
				onContextMenu={handleContextMenuEvent}
			>
				{entry.isDirectory ? (
					<>
						{expanded ? (
							<ChevronDown size={14} className="shrink-0 text-text-secondary" />
						) : (
							<ChevronRight size={14} className="shrink-0 text-text-secondary" />
						)}
						<Folder size={14} className="shrink-0 text-text-secondary" />
					</>
				) : (
					<>
						<span className="inline-block w-3.5 shrink-0" />
						<File size={14} className="shrink-0 text-text-secondary" />
					</>
				)}
				<span className="truncate">{entry.name}</span>
				{loadError && (
					<AlertTriangle size={12} className="shrink-0 text-red-500" aria-label="Failed to load" />
				)}
			</button>
			{entry.isDirectory &&
				expanded &&
				loaded &&
				(children.length > 0 || isCreatingHere ? (
					<ul>
						{isCreatingHere && (
							<InlineInput
								depth={depth + 1}
								icon={creating.type === "file" ? "file" : "folder"}
								onConfirm={onCreateConfirm}
								onCancel={onCreateCancel}
							/>
						)}
						{children.map((child) => (
							<FileTreeItem
								key={child.path}
								entry={child}
								depth={depth + 1}
								selectedPath={selectedPath}
								onFileSelect={onFileSelect}
								refreshKey={refreshKey}
								creating={creating}
								renamingPath={renamingPath}
								onContextMenu={onContextMenu}
								onRenameConfirm={onRenameConfirm}
								onCreateConfirm={onCreateConfirm}
								onRenameCancel={onRenameCancel}
								onCreateCancel={onCreateCancel}
							/>
						))}
					</ul>
				) : (
					<p
						className="py-0.5 text-xs text-text-secondary"
						style={{ paddingLeft: `${(depth + 1) * 16 + 4}px` }}
					>
						Empty folder
					</p>
				))}
		</li>
	);
}
