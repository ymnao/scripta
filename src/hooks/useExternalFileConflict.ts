import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { readFile } from "../lib/commands";
import { useWorkspaceStore } from "../stores/workspace";
import { useFileWatcher } from "./useFileWatcher";
import type { TabContentManager } from "./useTabContentManager";

export interface ExternalConflict {
	path: string;
	type: "modified" | "deleted";
}

/**
 * 外部変更の反映は tab cache と savedContent の内部表現に触れる必要があるが、
 * ref を直接受け取ると useTabContentManager の内部表現がそのまま契約になってしまう。
 * 公開された命令的 API だけを受け取る。
 */
export type ExternalFileConflictTabApi = Pick<
	TabContentManager,
	| "getLastSavedContent"
	| "applyExternalReload"
	| "applyCacheReload"
	| "applyConflictReload"
	| "dropTab"
	| "isCachedTabClean"
>;

export interface UseExternalFileConflictOptions extends ExternalFileConflictTabApi {
	/** ファイルツリーに影響する変更を観測したときに呼ばれる (コンフリクトとは独立の関心)。 */
	onTreeChange: () => void;
}

export interface ExternalFileConflictState {
	/** 表示中のダイアログ。null なら未発生。 */
	externalConflict: ExternalConflict | null;
	handleConflictReload: () => void;
	handleConflictKeep: () => void;
	handleDeletedDirtyDiscard: () => void;
	handleDeletedDirtyKeep: () => void;
}

/**
 * file watcher が観測したエディタ外のファイル変更・削除を、タブの状態に反映する。
 *
 * 未保存の変更があるタブが外部で書き換えられた場合だけユーザーに選択を求め、
 * それ以外は黙って cache / エディタへ反映する。
 */
export function useExternalFileConflict({
	onTreeChange,
	getLastSavedContent,
	applyExternalReload,
	applyCacheReload,
	applyConflictReload,
	dropTab,
	isCachedTabClean,
}: UseExternalFileConflictOptions): ExternalFileConflictState {
	const { workspacePath, closeTab } = useWorkspaceStore(
		useShallow((s) => ({
			workspacePath: s.workspacePath,
			closeTab: s.closeTab,
		})),
	);

	// Single state ensures only one dialog is shown at a time. When multiple
	// files have conflicts, the latest event wins; earlier conflicts are dropped
	// but dirty content is preserved in memory so no data is lost.
	const [externalConflict, setExternalConflict] = useState<ExternalConflict | null>(null);

	// Clear stale conflict dialog when workspace changes.
	// workspacePath is read only to satisfy the exhaustive-deps rule;
	// the real purpose is to trigger on workspace switches.
	const prevWorkspaceRef = useRef(workspacePath);
	useEffect(() => {
		if (prevWorkspaceRef.current !== workspacePath) {
			prevWorkspaceRef.current = workspacePath;
			setExternalConflict(null);
		}
	}, [workspacePath]);

	const handleExternalFileDeleted = useCallback(
		(path: string) => {
			const tab = useWorkspaceStore.getState().tabs.find((t) => t.path === path);
			if (!tab) return;

			if (tab.dirty) {
				// Deletion supersedes any pending conflict (modified) dialog
				setExternalConflict({ path, type: "deleted" });
			} else {
				dropTab(path);
				closeTab(path);
			}
		},
		[closeTab, dropTab],
	);

	const getLastSavedContentRef = useRef(getLastSavedContent);
	getLastSavedContentRef.current = getLastSavedContent;

	const handleExternalFileModified = useCallback(
		(path: string) => {
			const state = useWorkspaceStore.getState();
			const tab = state.tabs.find((t) => t.path === path);
			if (!tab) return;

			if (path === state.activeTabPath) {
				if (tab.dirty) {
					// Read file to check if this is our own save or genuine external change
					readFile(path)
						.then((loaded) => {
							if (useWorkspaceStore.getState().activeTabPath !== path) return;
							if (loaded === getLastSavedContentRef.current()) {
								// File matches what we last saved — this was our own write
								return;
							}
							// Don't overwrite a pending delete dialog (delete is more severe)
							setExternalConflict((prev) =>
								prev?.type === "deleted" ? prev : { path, type: "modified" },
							);
						})
						.catch((err) => {
							console.error("Failed to read file for conflict check:", err);
						});
				} else {
					readFile(path)
						.then((loaded) => {
							applyExternalReload(path, loaded);
						})
						.catch((err) => {
							console.error("Failed to reload file:", err);
						});
				}
			} else {
				// Non-active dirty tabs: intentionally no dialog shown here.
				// Showing a dialog would interrupt the user's current editing.
				// The dirty content stays in cache; the user can reconcile when
				// they switch to that tab.
				if (isCachedTabClean(path)) {
					readFile(path)
						.then((loaded) => {
							applyCacheReload(path, loaded);
						})
						.catch((err) => {
							console.error("Failed to reload cached file:", err);
						});
				}
			}
		},
		[applyExternalReload, applyCacheReload, isCachedTabClean],
	);

	useFileWatcher({
		workspacePath,
		onTreeChange,
		onFileModified: handleExternalFileModified,
		onFileDeleted: handleExternalFileDeleted,
	});

	const handleConflictReload = useCallback(() => {
		if (externalConflict?.type !== "modified") return;
		const path = externalConflict.path;
		setExternalConflict(null);
		readFile(path)
			.then((loaded) => {
				applyConflictReload(path, loaded);
			})
			.catch((err) => {
				console.error("Failed to reload file on conflict resolve:", err);
				// File may have been deleted — notify user via the deleted dialog
				setExternalConflict({ path, type: "deleted" });
			});
	}, [externalConflict, applyConflictReload]);

	const handleConflictKeep = useCallback(() => {
		setExternalConflict(null);
	}, []);

	const handleDeletedDirtyDiscard = useCallback(() => {
		if (externalConflict?.type !== "deleted") return;
		const path = externalConflict.path;
		setExternalConflict(null);
		dropTab(path);
		closeTab(path);
	}, [externalConflict, closeTab, dropTab]);

	const handleDeletedDirtyKeep = useCallback(() => {
		setExternalConflict(null);
	}, []);

	return {
		externalConflict,
		handleConflictReload,
		handleConflictKeep,
		handleDeletedDirtyDiscard,
		handleDeletedDirtyKeep,
	};
}
