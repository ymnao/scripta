import { useCallback, useEffect, useRef, useState } from "react";
import {
	createDirectory,
	createFile,
	deleteEntry,
	listDirectory,
	renameEntry,
	showInFolder,
} from "../../lib/commands";
import { translateError } from "../../lib/errors";
import { SEP_RE, dirname, joinPath, replaceName } from "../../lib/path";
import { useToastStore } from "../../stores/toast";
import { useWorkspaceStore } from "../../stores/workspace";
import type { FileEntry } from "../../types/workspace";
import { Dialog } from "../common/Dialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { FileTreeItem } from "./FileTreeItem";
import { InlineInput } from "./InlineInput";

interface FileTreeProps {
	workspacePath: string;
	selectedPath: string | null;
	onFileSelect: (path: string) => void;
	onFileOpenNewTab?: (path: string) => void;
	onFileRenamed?: (oldPath: string, newPath: string, isDirectory: boolean) => void;
	onFileDeleted?: (path: string, isDirectory: boolean) => void;
	onExport?: (path: string) => void;
}

interface ContextMenuState {
	position: { x: number; y: number };
	entry: FileEntry | null;
}

interface CreatingState {
	parentPath: string;
	type: "file" | "folder";
}

function validateName(name: string): string | null {
	if (SEP_RE.test(name)) return "ファイル名にパス区切り文字は使用できません";
	if (name === "." || name === "..") return "ファイル名に「.」や「..」は使用できません";
	return null;
}

export function FileTree({
	workspacePath,
	selectedPath,
	onFileSelect,
	onFileOpenNewTab,
	onFileRenamed,
	onFileDeleted,
	onExport,
}: FileTreeProps) {
	const [entries, setEntries] = useState<FileEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshKey, setRefreshKey] = useState(0);

	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
	const [creating, setCreating] = useState<CreatingState | null>(null);
	const [renamingEntry, setRenamingEntry] = useState<FileEntry | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);

	const loadIdRef = useRef(0);

	const loadEntries = useCallback(
		(silent = false) => {
			const id = ++loadIdRef.current;
			setError(null);
			if (!silent) setLoading(true);
			listDirectory(workspacePath)
				.then((result) => {
					if (loadIdRef.current !== id) return;
					setEntries(result);
				})
				.catch((err) => {
					if (loadIdRef.current !== id) return;
					console.error("Failed to load workspace:", err);
					if (!silent) setError("フォルダの読み込みに失敗しました");
				})
				.finally(() => {
					if (loadIdRef.current !== id) return;
					if (!silent) setLoading(false);
				});
		},
		[workspacePath],
	);

	const fileTreeVersion = useWorkspaceStore((s) => s.fileTreeVersion);
	const prevFileTreeVersionRef = useRef(fileTreeVersion);

	useEffect(() => {
		setEntries([]);
		loadEntries();
		// Sync version ref so the fileTreeVersion effect below doesn't
		// trigger a redundant refresh when workspace changes reset the counter.
		prevFileTreeVersionRef.current = useWorkspaceStore.getState().fileTreeVersion;
	}, [loadEntries]);

	const refresh = useCallback(() => {
		loadEntries(true);
		setRefreshKey((k) => k + 1);
	}, [loadEntries]);

	useEffect(() => {
		if (prevFileTreeVersionRef.current === fileTreeVersion) return;
		prevFileTreeVersionRef.current = fileTreeVersion;
		refresh();
	}, [fileTreeVersion, refresh]);

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

		const items: ContextMenuItem[] = [];

		if (entry && !entry.isDirectory) {
			if (onFileOpenNewTab) {
				items.push({
					id: "open-new-tab",
					label: "新しいタブで開く",
					onClick: () => onFileOpenNewTab(entry.path),
				});
			}
			if (onExport) {
				items.push({
					id: "export",
					label: "エクスポート...",
					onClick: () => onExport(entry.path),
				});
			}
			if (onFileOpenNewTab || onExport) {
				items.push({
					id: "separator-open",
					label: "---",
					separator: true,
					onClick: () => {},
				});
			}
		}

		items.push(
			{
				id: "new-file",
				label: "New File",
				onClick: () => setCreating({ parentPath, type: "file" }),
			},
			{
				id: "new-folder",
				label: "New Folder",
				onClick: () => setCreating({ parentPath, type: "folder" }),
			},
		);

		if (entry) {
			items.push({
				id: "separator",
				label: "---",
				separator: true,
				onClick: () => {},
			});
			items.push({
				id: "show-in-folder",
				label: "フォルダで表示",
				onClick: () => {
					showInFolder(entry.path).catch((err) => {
						useToastStore
							.getState()
							.addToast("error", `フォルダの表示に失敗しました: ${translateError(err)}`);
					});
				},
			});
			items.push({
				id: "rename",
				label: "Rename",
				onClick: () => setRenamingEntry(entry),
			});
			items.push({
				id: "delete",
				label: "Delete",
				danger: true,
				onClick: () => setDeleteTarget(entry),
			});
		}

		return items;
	}, [contextMenu, workspacePath, onFileOpenNewTab, onExport]);

	const handleCreateConfirm = useCallback(
		async (name: string) => {
			if (!creating) return;
			const nameError = validateName(name);
			if (nameError) {
				useToastStore.getState().addToast("warning", nameError);
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
				useToastStore.getState().addToast("error", `作成に失敗しました: ${translateError(err)}`);
			}
			setCreating(null);
		},
		[creating, refresh, onFileSelect],
	);

	const handleCreateCancel = useCallback(() => setCreating(null), []);

	const handleRenameConfirm = useCallback(
		async (newName: string) => {
			if (!renamingEntry) return;
			const nameError = validateName(newName);
			if (nameError) {
				useToastStore.getState().addToast("warning", nameError);
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
				refresh();
				onFileRenamed?.(oldPath, newPath, renamingEntry.isDirectory);
			} catch (err) {
				console.error("Failed to rename:", err);
				useToastStore
					.getState()
					.addToast("error", `名前の変更に失敗しました: ${translateError(err)}`);
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
			refresh();
			onFileDeleted?.(deleteTarget.path, deleteTarget.isDirectory);
		} catch (err) {
			console.error("Failed to delete:", err);
			useToastStore.getState().addToast("error", `削除に失敗しました: ${translateError(err)}`);
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
						onFileOpenNewTab={onFileOpenNewTab}
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
				title={`${deleteTarget?.isDirectory ? "フォルダ" : "ファイル"}を削除`}
				description={`「${deleteTarget?.name}」を削除しますか？ゴミ箱に移動されます。`}
				confirmLabel="削除"
				cancelLabel="キャンセル"
				variant="danger"
				onConfirm={handleDeleteConfirm}
				onCancel={handleDeleteCancel}
			/>
		</>
	);
}
