import { AlertTriangle, ChevronDown, ChevronRight, Folder } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listDirectory } from "../../lib/commands";
import { getFileIcon } from "../../lib/file-icon";
import { toRelativePath } from "../../lib/path";
import { useDragStore } from "../../stores/drag";
import type { FileEntry } from "../../types/workspace";
import { InlineInput } from "./InlineInput";

const DRAG_EXPAND_DELAY = 500;

interface CreatingState {
	parentPath: string;
	type: "file" | "folder";
}

interface FileTreeItemProps {
	entry: FileEntry;
	depth: number;
	selectedPath: string | null;
	onFileSelect: (path: string) => void;
	onFileOpenNewTab?: (path: string) => void;
	refreshKey: number;
	creating: CreatingState | null;
	renamingPath: string | null;
	onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
	onRenameConfirm: (newName: string) => void;
	onCreateConfirm: (name: string) => void;
	onRenameCancel: () => void;
	onCreateCancel: () => void;
	icons?: Record<string, string>;
	workspacePath?: string;
}

export function FileTreeItem({
	entry,
	depth,
	selectedPath,
	onFileSelect,
	onFileOpenNewTab,
	refreshKey,
	creating,
	renamingPath,
	onContextMenu,
	onRenameConfirm,
	onCreateConfirm,
	onRenameCancel,
	onCreateCancel,
	icons,
	workspacePath,
}: FileTreeItemProps) {
	const [expanded, setExpanded] = useState(false);
	const [children, setChildren] = useState<FileEntry[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState(false);
	const isMountedRef = useRef(true);

	const isDragSource = useDragStore((s) => s.sourcePath === entry.path);
	const isDragOver = useDragStore((s) => s.overPath === entry.path && entry.isDirectory);
	const isHoverTarget = useDragStore(
		(s) => s.hoverPath === entry.path && s.sourcePath !== entry.path,
	);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
		};
	}, []);

	const loadChildren = useCallback(() => {
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
	}, [entry.path]);

	const isSelected = entry.path === selectedPath;
	const isRenaming = entry.path === renamingPath;
	const isCreatingHere = creating?.parentPath === entry.path && entry.isDirectory;

	// Auto-expand folder when creating inside it
	useEffect(() => {
		if (isCreatingHere && !expanded) {
			if (!loaded && !loading && !loadError) {
				loadChildren();
			} else if (loaded) {
				setExpanded(true);
			}
		}
	}, [isCreatingHere, expanded, loaded, loading, loadError, loadChildren]);

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

	// Auto-expand folder on drag hover (500ms)
	useEffect(() => {
		if (!isDragOver || expanded) return;
		const timer = setTimeout(() => {
			if (!loaded && !loading && !loadError) {
				loadChildren();
			} else if (loaded) {
				setExpanded(true);
			}
		}, DRAG_EXPAND_DELAY);
		return () => clearTimeout(timer);
	}, [isDragOver, expanded, loaded, loading, loadError, loadChildren]);

	const handleClick = useCallback(
		(e: React.MouseEvent) => {
			if (entry.isDirectory) {
				if ((!loaded || loadError) && !loading) {
					loadChildren();
				} else if (loaded) {
					setExpanded((prev) => !prev);
				}
			} else if ((e.metaKey || e.ctrlKey) && onFileOpenNewTab) {
				onFileOpenNewTab(entry.path);
			} else {
				onFileSelect(entry.path);
			}
		},
		[
			entry.isDirectory,
			entry.path,
			loaded,
			loadError,
			loading,
			loadChildren,
			onFileSelect,
			onFileOpenNewTab,
		],
	);

	const handleContextMenuEvent = useCallback(
		(e: React.MouseEvent) => {
			onContextMenu(e, entry);
		},
		[onContextMenu, entry],
	);

	const entryEmoji = (() => {
		const rel = workspacePath ? toRelativePath(workspacePath, entry.path) : null;
		if (!rel || !icons) return undefined;
		if (entry.isDirectory) {
			const withSlash = rel.endsWith("/") ? rel : `${rel}/`;
			const withoutSlash = rel.endsWith("/") ? rel.slice(0, -1) : rel;
			return Object.hasOwn(icons, withSlash)
				? icons[withSlash]
				: Object.hasOwn(icons, withoutSlash)
					? icons[withoutSlash]
					: undefined;
		}
		return Object.hasOwn(icons, rel) ? icons[rel] : undefined;
	})();

	if (isRenaming) {
		return (
			<InlineInput
				depth={depth}
				defaultValue={entry.name}
				icon={entry.isDirectory ? "folder" : "file"}
				emoji={entryEmoji}
				onConfirm={onRenameConfirm}
				onCancel={onRenameCancel}
			/>
		);
	}

	return (
		<li>
			<button
				type="button"
				role="treeitem"
				data-path={entry.path}
				data-is-directory={entry.isDirectory}
				aria-label={`${entry.name} ${entry.isDirectory ? "folder" : "file"}`}
				aria-expanded={entry.isDirectory ? expanded : undefined}
				aria-selected={isSelected || undefined}
				className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 ${isSelected ? "bg-black/10 dark:bg-white/10" : ""} ${isDragSource ? "opacity-40" : ""} ${isDragOver ? "bg-black/10 dark:bg-white/10" : isHoverTarget ? "bg-black/5 dark:bg-white/5" : ""}`}
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
						{entryEmoji ? (
							<span className="inline-flex w-3.5 shrink-0 items-center justify-center text-sm leading-none">
								{entryEmoji}
							</span>
						) : (
							<Folder size={14} className="shrink-0 text-text-secondary" />
						)}
					</>
				) : (
					<>
						<span className="inline-block w-3.5 shrink-0" />
						{entryEmoji ? (
							<span className="inline-flex w-3.5 shrink-0 items-center justify-center text-sm leading-none">
								{entryEmoji}
							</span>
						) : (
							(() => {
								const Icon = getFileIcon(entry.name);
								return <Icon size={14} className="shrink-0 text-text-secondary" />;
							})()
						)}
					</>
				)}
				<span className="truncate">{entry.name}</span>
				{loadError && (
					<AlertTriangle
						size={12}
						className="shrink-0 text-red-500"
						aria-label="読み込みに失敗しました"
					/>
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
								onFileOpenNewTab={onFileOpenNewTab}
								refreshKey={refreshKey}
								creating={creating}
								renamingPath={renamingPath}
								onContextMenu={onContextMenu}
								onRenameConfirm={onRenameConfirm}
								onCreateConfirm={onCreateConfirm}
								onRenameCancel={onRenameCancel}
								onCreateCancel={onCreateCancel}
								icons={icons}
								workspacePath={workspacePath}
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
