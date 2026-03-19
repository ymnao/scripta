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
import { SEP_RE, addTrailingSep, basename, dirname, joinPath, replaceName } from "../../lib/path";
import { getScriptaDir, scriptaDirExists } from "../../lib/scripta-config";
import { useDragStore } from "../../stores/drag";
import { useToastStore } from "../../stores/toast";
import { useWorkspaceStore } from "../../stores/workspace";
import { toRelativePath, useWorkspaceConfigStore } from "../../stores/workspace-config";
import type { FileEntry } from "../../types/workspace";
import { Dialog } from "../common/Dialog";
import { EmojiInputDialog } from "../common/EmojiInputDialog";
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

const DRAG_THRESHOLD = 5;
const GHOST_CURSOR_OFFSET = 12;

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

	const [emojiTarget, setEmojiTarget] = useState<FileEntry | null>(null);
	const [scriptaDirConfirmTarget, setScriptaDirConfirmTarget] = useState<FileEntry | null>(null);

	const isRootDragOver = useDragStore((s) => s.overPath === workspacePath);

	const dragRef = useRef<{
		source: { path: string; isDirectory: boolean };
		startX: number;
		startY: number;
		started: boolean;
		ghost: HTMLDivElement | null;
	} | null>(null);
	const rootUlRef = useRef<HTMLUListElement>(null);
	const skipNextClickRef = useRef(false);

	const workspacePathRef = useRef(workspacePath);
	workspacePathRef.current = workspacePath;

	const icons = useWorkspaceConfigStore((s) => s.icons);
	const scriptaDirReady = useWorkspaceConfigStore((s) => s.scriptaDirReady);
	const setIcon = useWorkspaceConfigStore((s) => s.setIcon);
	const removeIcon = useWorkspaceConfigStore((s) => s.removeIcon);
	const renameIcon = useWorkspaceConfigStore((s) => s.renameIcon);
	const renameIconsByPrefix = useWorkspaceConfigStore((s) => s.renameIconsByPrefix);
	const deleteIconsByPrefix = useWorkspaceConfigStore((s) => s.deleteIconsByPrefix);
	const setScriptaDirReady = useWorkspaceConfigStore((s) => s.setScriptaDirReady);

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
				id: "set-icon",
				label: "アイコンを設定...",
				onClick: async () => {
					if (scriptaDirReady) {
						setEmojiTarget(entry);
					} else {
						const exists = await scriptaDirExists(workspacePath);
						if (exists) {
							setScriptaDirReady(true);
							setEmojiTarget(entry);
						} else {
							setScriptaDirConfirmTarget(entry);
						}
					}
				},
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
	}, [contextMenu, workspacePath, onFileOpenNewTab, onExport, scriptaDirReady, setScriptaDirReady]);

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

	const executeRename = useCallback(
		async (oldPath: string, newPath: string, isDirectory: boolean) => {
			await renameEntry(oldPath, newPath);
			const oldRel = toRelativePath(workspacePath, oldPath);
			const newRel = toRelativePath(workspacePath, newPath);
			if (isDirectory) {
				renameIconsByPrefix(workspacePath, oldRel, newRel);
			} else {
				renameIcon(workspacePath, oldRel, newRel);
			}
			refresh();
			onFileRenamed?.(oldPath, newPath, isDirectory);
		},
		[workspacePath, renameIcon, renameIconsByPrefix, refresh, onFileRenamed],
	);

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
				await executeRename(oldPath, newPath, renamingEntry.isDirectory);
			} catch (err) {
				console.error("Failed to rename:", err);
				useToastStore
					.getState()
					.addToast("error", `名前の変更に失敗しました: ${translateError(err)}`);
			}
			setRenamingEntry(null);
		},
		[renamingEntry, executeRename],
	);

	const handleRenameCancel = useCallback(() => setRenamingEntry(null), []);

	const handleMoveEntry = useCallback(
		async (source: { path: string; isDirectory: boolean }, targetDirPath: string) => {
			const sourcePath = source.path;
			const newPath = joinPath(targetDirPath, basename(sourcePath));

			// Self-drop
			if (sourcePath === targetDirPath) return;

			// Same parent
			if (dirname(sourcePath) === targetDirPath) return;

			// Workspace boundary check
			const wsPrefix = addTrailingSep(workspacePath);
			if (
				!sourcePath.startsWith(wsPrefix) ||
				(!targetDirPath.startsWith(wsPrefix) && targetDirPath !== workspacePath)
			) {
				console.error("Move target is outside workspace");
				return;
			}

			// Circular move check
			if (source.isDirectory) {
				const sourcePrefix = addTrailingSep(sourcePath);
				if (targetDirPath.startsWith(sourcePrefix)) {
					useToastStore
						.getState()
						.addToast("error", "フォルダを自身の子孫に移動することはできません");
					return;
				}
			}

			try {
				await executeRename(sourcePath, newPath, source.isDirectory);
			} catch (err) {
				console.error("Failed to move:", err);
				useToastStore.getState().addToast("error", `移動に失敗しました: ${translateError(err)}`);
			}
		},
		[workspacePath, executeRename],
	);

	const handleMoveEntryRef = useRef(handleMoveEntry);
	handleMoveEntryRef.current = handleMoveEntry;

	const findDropTarget = useCallback(
		(clientX: number, clientY: number, skipPath: string): string | null => {
			const rootUl = rootUlRef.current;
			if (!rootUl) return null;

			const rootRect = rootUl.getBoundingClientRect();
			if (
				clientX < rootRect.left ||
				clientX > rootRect.right ||
				clientY < rootRect.top ||
				clientY > rootRect.bottom
			) {
				return null;
			}

			const buttons = rootUl.querySelectorAll<HTMLElement>("[data-path]");
			for (const btn of buttons) {
				const path = btn.dataset.path;
				if (!path) continue;
				const rect = btn.getBoundingClientRect();
				if (clientY >= rect.top && clientY < rect.bottom) {
					if (path === skipPath) return null;
					return btn.dataset.isDirectory === "true" ? path : dirname(path);
				}
			}

			return workspacePathRef.current;
		},
		[],
	);

	const handlePointerDown = useCallback((e: React.PointerEvent) => {
		if (e.button !== 0) return;
		const target = (e.target as Element).closest<HTMLElement>("[data-path]");
		if (!target?.dataset.path) return;
		dragRef.current = {
			source: {
				path: target.dataset.path,
				isDirectory: target.dataset.isDirectory === "true",
			},
			startX: e.clientX,
			startY: e.clientY,
			started: false,
			ghost: null,
		};
		setContextMenu(null);
	}, []);

	useEffect(() => {
		const handlePointerMove = (e: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag) return;

			const dx = e.clientX - drag.startX;
			const dy = e.clientY - drag.startY;

			if (!drag.started) {
				if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
				drag.started = true;
				useDragStore.getState().setSourcePath(drag.source.path);
				document.body.style.cursor = "grabbing";

				const ghost = document.createElement("div");
				ghost.style.cssText =
					"position:fixed;pointer-events:none;z-index:50;border-radius:4px;padding:2px 8px;font-size:12px;line-height:1.5;opacity:0.9;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.15)";
				ghost.style.backgroundColor = "var(--color-bg-secondary)";
				ghost.style.color = "var(--color-text-primary)";
				ghost.textContent = basename(drag.source.path);
				document.body.appendChild(ghost);
				drag.ghost = ghost;
			}

			if (drag.ghost) {
				drag.ghost.style.left = `${e.clientX + GHOST_CURSOR_OFFSET}px`;
				drag.ghost.style.top = `${e.clientY + GHOST_CURSOR_OFFSET}px`;
			}

			const target = findDropTarget(e.clientX, e.clientY, drag.source.path);
			useDragStore.getState().setOverPath(target);
		};

		const handlePointerUp = (e: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag) return;

			if (drag.started) {
				skipNextClickRef.current = true;
				const target = findDropTarget(e.clientX, e.clientY, drag.source.path);
				if (target) {
					handleMoveEntryRef.current(drag.source, target);
				}
				document.body.style.cursor = "";
			}

			if (drag.ghost) {
				drag.ghost.remove();
			}
			dragRef.current = null;
			useDragStore.getState().reset();
		};

		document.addEventListener("pointermove", handlePointerMove);
		document.addEventListener("pointerup", handlePointerUp);
		document.addEventListener("pointercancel", handlePointerUp);
		return () => {
			document.removeEventListener("pointermove", handlePointerMove);
			document.removeEventListener("pointerup", handlePointerUp);
			document.removeEventListener("pointercancel", handlePointerUp);
			// Clean up drag state on unmount
			const drag = dragRef.current;
			if (drag?.ghost) {
				drag.ghost.remove();
			}
			if (drag?.started) {
				document.body.style.cursor = "";
			}
			dragRef.current = null;
			useDragStore.getState().reset();
		};
	}, [findDropTarget]);

	const handleDeleteConfirm = useCallback(async () => {
		if (!deleteTarget) return;
		try {
			await deleteEntry(deleteTarget.path);
			const rel = toRelativePath(workspacePath, deleteTarget.path);
			if (deleteTarget.isDirectory) {
				deleteIconsByPrefix(workspacePath, rel);
			} else {
				removeIcon(workspacePath, rel);
			}
			refresh();
			onFileDeleted?.(deleteTarget.path, deleteTarget.isDirectory);
		} catch (err) {
			console.error("Failed to delete:", err);
			useToastStore.getState().addToast("error", `削除に失敗しました: ${translateError(err)}`);
		}
		setDeleteTarget(null);
	}, [deleteTarget, onFileDeleted, refresh, workspacePath, removeIcon, deleteIconsByPrefix]);

	const handleDeleteCancel = useCallback(() => setDeleteTarget(null), []);

	const handleScriptaDirConfirm = useCallback(async () => {
		const entry = scriptaDirConfirmTarget;
		setScriptaDirConfirmTarget(null);
		try {
			await createDirectory(getScriptaDir(workspacePath));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("Already exists")) {
				console.error("Failed to create .scripta directory:", err);
				useToastStore
					.getState()
					.addToast("error", `.scripta ディレクトリの作成に失敗しました: ${translateError(err)}`);
				return;
			}
		}
		setScriptaDirReady(true);
		if (entry) setEmojiTarget(entry);
	}, [scriptaDirConfirmTarget, setScriptaDirReady, workspacePath]);

	const handleScriptaDirCancel = useCallback(() => {
		setScriptaDirConfirmTarget(null);
	}, []);

	const handleEmojiConfirm = useCallback(
		(emoji: string) => {
			if (!emojiTarget) return;
			const rel = toRelativePath(workspacePath, emojiTarget.path);
			const key = emojiTarget.isDirectory ? `${rel}/` : rel;
			setIcon(workspacePath, key, emoji);
			setEmojiTarget(null);
		},
		[emojiTarget, workspacePath, setIcon],
	);

	const handleEmojiRemove = useCallback(() => {
		if (!emojiTarget) return;
		const rel = toRelativePath(workspacePath, emojiTarget.path);
		const key = emojiTarget.isDirectory ? `${rel}/` : rel;
		removeIcon(workspacePath, key);
		setEmojiTarget(null);
	}, [emojiTarget, workspacePath, removeIcon]);

	const handleEmojiCancel = useCallback(() => {
		setEmojiTarget(null);
	}, []);

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
				ref={rootUlRef}
				className={`min-h-full select-none overflow-y-auto px-1 py-1 ${isRootDragOver ? "bg-black/5 dark:bg-white/5" : ""}`}
				onContextMenu={handleRootContextMenu}
				onPointerDown={handlePointerDown}
				onClickCapture={(e) => {
					if (skipNextClickRef.current) {
						skipNextClickRef.current = false;
						e.stopPropagation();
						e.preventDefault();
					}
				}}
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
						icons={icons}
						workspacePath={workspacePath}
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

			<Dialog
				open={scriptaDirConfirmTarget !== null}
				title="ワークスペース設定フォルダを作成"
				description="アイコン設定を保存するため、ワークスペース内に .scripta/ フォルダを作成します。よろしいですか？"
				confirmLabel="作成"
				cancelLabel="キャンセル"
				onConfirm={handleScriptaDirConfirm}
				onCancel={handleScriptaDirCancel}
			/>

			<EmojiInputDialog
				open={emojiTarget !== null}
				currentEmoji={
					emojiTarget
						? (() => {
								const rel = toRelativePath(workspacePath, emojiTarget.path);
								if (emojiTarget.isDirectory) {
									return icons[`${rel}/`] ?? icons[rel] ?? null;
								}
								return icons[rel] ?? null;
							})()
						: null
				}
				entryName={emojiTarget?.name ?? ""}
				onConfirm={handleEmojiConfirm}
				onRemove={handleEmojiRemove}
				onCancel={handleEmojiCancel}
			/>
		</>
	);
}
