import { useCallback, useEffect, useRef, useState } from "react";
import {
	createDirectory,
	createFile,
	deleteEntry,
	listDirectory,
	renameEntry,
} from "../../lib/commands";
import { dirname, joinPath, replaceName } from "../../lib/path";
import type { FileEntry } from "../../types/workspace";
import { Dialog } from "../common/Dialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { FileTreeItem } from "./FileTreeItem";
import { InlineInput } from "./InlineInput";

interface FileTreeProps {
	workspacePath: string;
	selectedPath: string | null;
	onFileSelect: (path: string) => void;
	onFileRenamed?: (oldPath: string, newPath: string, isDirectory: boolean) => void;
	onFileDeleted?: (path: string, isDirectory: boolean) => void;
}

interface ContextMenuState {
	position: { x: number; y: number };
	entry: FileEntry | null;
}

interface CreatingState {
	parentPath: string;
	type: "file" | "folder";
}

export function FileTree({
	workspacePath,
	selectedPath,
	onFileSelect,
	onFileRenamed,
	onFileDeleted,
}: FileTreeProps) {
	const [entries, setEntries] = useState<FileEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshKey, setRefreshKey] = useState(0);

	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	const [creating, setCreating] = useState<CreatingState | null>(null);
	const [renamingEntry, setRenamingEntry] = useState<FileEntry | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
	const [operationError, setOperationError] = useState<string | null>(null);

	const loadIdRef = useRef(0);

	const loadEntries = useCallback(() => {
		const id = ++loadIdRef.current;
		setError(null);
		setLoading(true);
		listDirectory(workspacePath)
			.then((result) => {
				if (loadIdRef.current !== id) return;
				setEntries(result);
			})
			.catch((err) => {
				if (loadIdRef.current !== id) return;
				console.error("Failed to load workspace:", err);
				setError("Failed to load folder");
			})
			.finally(() => {
				if (loadIdRef.current !== id) return;
				setLoading(false);
			});
	}, [workspacePath]);

	useEffect(() => {
		setEntries([]);
		loadEntries();
	}, [loadEntries]);

	const refresh = useCallback(() => {
		loadEntries();
		setRefreshKey((k) => k + 1);
	}, [loadEntries]);

	const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry | null) => {
		e.preventDefault();
		e.stopPropagation();
		setContextMenu({ position: { x: e.clientX, y: e.clientY }, entry });
	}, []);

	const closeContextMenu = useCallback(() => setContextMenu(null), []);

	const getContextMenuItems = useCallback((): ContextMenuItem[] => {
		const entry = contextMenu?.entry;
		const parentPath = entry
			? entry.isDirectory
				? entry.path
				: dirname(entry.path)
			: workspacePath;

		const items: ContextMenuItem[] = [
			{
				label: "New File",
				onClick: () => setCreating({ parentPath, type: "file" }),
			},
			{
				label: "New Folder",
				onClick: () => setCreating({ parentPath, type: "folder" }),
			},
		];

		if (entry) {
			items.push({
				label: "---",
				separator: true,
				onClick: () => {},
			});
			items.push({
				label: "Rename",
				onClick: () => setRenamingEntry(entry),
			});
			items.push({
				label: "Delete",
				danger: true,
				onClick: () => setDeleteTarget(entry),
			});
		}

		return items;
	}, [contextMenu, workspacePath]);

	const handleCreateConfirm = useCallback(
		async (name: string) => {
			if (!creating) return;
			if (/[/\\]/.test(name)) {
				setOperationError("File name cannot contain path separators");
				setCreating(null);
				return;
			}
			const path = joinPath(creating.parentPath, name);
			try {
				if (creating.type === "file") {
					await createFile(path);
					refresh();
					onFileSelect(path);
				} else {
					await createDirectory(path);
					refresh();
				}
			} catch (err) {
				console.error("Failed to create:", err);
				const msg = err instanceof Error ? err.message : String(err);
				setOperationError(`Failed to create ${creating.type}: ${msg}`);
			}
			setCreating(null);
		},
		[creating, refresh, onFileSelect],
	);

	const handleCreateCancel = useCallback(() => setCreating(null), []);

	const handleRenameConfirm = useCallback(
		async (newName: string) => {
			if (!renamingEntry) return;
			if (/[/\\]/.test(newName)) {
				setOperationError("File name cannot contain path separators");
				setRenamingEntry(null);
				return;
			}
			const oldPath = renamingEntry.path;
			const newPath = replaceName(oldPath, newName);

			if (newPath === oldPath) {
				setRenamingEntry(null);
				return;
			}

			try {
				await renameEntry(oldPath, newPath);
				onFileRenamed?.(oldPath, newPath, renamingEntry.isDirectory);
				refresh();
			} catch (err) {
				console.error("Failed to rename:", err);
				const msg = err instanceof Error ? err.message : String(err);
				setOperationError(`Failed to rename: ${msg}`);
			}
			setRenamingEntry(null);
		},
		[renamingEntry, onFileRenamed, refresh],
	);

	const handleRenameCancel = useCallback(() => setRenamingEntry(null), []);

	const handleDeleteConfirm = useCallback(async () => {
		if (!deleteTarget) return;
		try {
			await deleteEntry(deleteTarget.path);
			onFileDeleted?.(deleteTarget.path, deleteTarget.isDirectory);
			refresh();
		} catch (err) {
			console.error("Failed to delete:", err);
			const msg = err instanceof Error ? err.message : String(err);
			setOperationError(`Failed to delete: ${msg}`);
		}
		setDeleteTarget(null);
	}, [deleteTarget, onFileDeleted, refresh]);

	const handleDeleteCancel = useCallback(() => setDeleteTarget(null), []);

	const handleRootContextMenu = useCallback(
		(e: React.MouseEvent) => {
			handleContextMenu(e, null);
		},
		[handleContextMenu],
	);

	// Auto-dismiss operation error after 5 seconds
	useEffect(() => {
		if (!operationError) return;
		const timer = setTimeout(() => setOperationError(null), 5000);
		return () => clearTimeout(timer);
	}, [operationError]);

	if (error) {
		return <p className="px-3 py-2 text-xs text-text-secondary">{error}</p>;
	}

	if (loading) {
		return <p className="px-3 py-2 text-xs text-text-secondary">Loading...</p>;
	}

	const showRootCreating = creating?.parentPath === workspacePath;
	const renamingPath = renamingEntry?.path ?? null;

	return (
		<>
			{operationError && (
				<p className="bg-red-50 px-3 py-1.5 text-xs text-red-600 dark:bg-red-900/20 dark:text-red-400">
					{operationError}
				</p>
			)}
			<ul
				className="min-h-full select-none overflow-y-auto px-1 py-1"
				onContextMenu={handleRootContextMenu}
			>
				{showRootCreating && (
					<InlineInput
						depth={0}
						icon={creating.type === "file" ? "file" : "folder"}
						onConfirm={handleCreateConfirm}
						onCancel={handleCreateCancel}
					/>
				)}
				{entries.map((entry) => (
					<FileTreeItem
						key={entry.path}
						entry={entry}
						depth={0}
						selectedPath={selectedPath}
						onFileSelect={onFileSelect}
						refreshKey={refreshKey}
						creating={creating}
						renamingPath={renamingPath}
						onContextMenu={handleContextMenu}
						onRenameConfirm={handleRenameConfirm}
						onCreateConfirm={handleCreateConfirm}
						onRenameCancel={handleRenameCancel}
						onCreateCancel={handleCreateCancel}
					/>
				))}
				{entries.length === 0 && !showRootCreating && (
					<li className="px-3 py-2 text-xs text-text-secondary">Empty folder</li>
				)}
			</ul>

			{contextMenu && (
				<ContextMenu
					position={contextMenu.position}
					items={getContextMenuItems()}
					onClose={closeContextMenu}
				/>
			)}

			<Dialog
				open={deleteTarget !== null}
				title={`Delete ${deleteTarget?.isDirectory ? "folder" : "file"}`}
				description={`Are you sure you want to delete "${deleteTarget?.name}"? It will be moved to the trash.`}
				confirmLabel="Delete"
				cancelLabel="Cancel"
				variant="danger"
				onConfirm={handleDeleteConfirm}
				onCancel={handleDeleteCancel}
			/>
		</>
	);
}
