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
	| "getCachedContent"
	| "markCachedTabConflict"
	| "takeCachedConflict"
	| "holdAutoSave"
	| "releaseAutoSave"
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
	getCachedContent,
	markCachedTabConflict,
	takeCachedConflict,
	holdAutoSave,
	releaseAutoSave,
}: UseExternalFileConflictOptions): ExternalFileConflictState {
	const { workspacePath, activeTabPath, closeTab } = useWorkspaceStore(
		useShallow((s) => ({
			workspacePath: s.workspacePath,
			activeTabPath: s.activeTabPath,
			closeTab: s.closeTab,
		})),
	);

	// Single state ensures only one dialog is shown at a time. When multiple
	// files have conflicts, the latest event wins; earlier conflicts are dropped
	// but dirty content is preserved in memory so no data is lost.
	const [externalConflict, setExternalConflict] = useState<ExternalConflict | null>(null);
	// ダイアログを出している間は autosave のタイマーを止める (#703)。止めないと、user が
	// 「再読み込み」を選ぶ前に未保存の内容が書き込まれ、外部の変更が消える。
	// state ではなく ref で開閉を追うのは、handleConflictReload の readFile 完了時に
	// 「その間に別のダイアログが開いたか」を同期的に知る必要があるため。
	const conflictOpenRef = useRef(false);

	const openConflict = useCallback(
		(path: string, type: ExternalConflict["type"]) => {
			conflictOpenRef.current = true;
			holdAutoSave();
			// Don't overwrite a pending delete dialog with modified (delete is more severe)
			setExternalConflict((prev) =>
				type === "modified" && prev?.type === "deleted" ? prev : { path, type },
			);
		},
		[holdAutoSave],
	);

	const closeConflict = useCallback(() => {
		conflictOpenRef.current = false;
		setExternalConflict(null);
		releaseAutoSave();
	}, [releaseAutoSave]);

	// Clear stale conflict dialog when workspace changes.
	// workspacePath is read only to satisfy the exhaustive-deps rule;
	// the real purpose is to trigger on workspace switches.
	const prevWorkspaceRef = useRef(workspacePath);
	useEffect(() => {
		if (prevWorkspaceRef.current !== workspacePath) {
			prevWorkspaceRef.current = workspacePath;
			closeConflict();
		}
	}, [workspacePath, closeConflict]);

	// 非 active の間に外部変更を受けたタブへ戻ってきた。cache から復元した時点で
	// autosave が張られているので、openConflict で止めてから選ばせる。
	useEffect(() => {
		if (activeTabPath && takeCachedConflict(activeTabPath)) {
			openConflict(activeTabPath, "modified");
		}
	}, [activeTabPath, takeCachedConflict, openConflict]);

	const handleExternalFileDeleted = useCallback(
		(path: string) => {
			const tab = useWorkspaceStore.getState().tabs.find((t) => t.path === path);
			if (!tab) return;

			if (tab.dirty) {
				// Deletion supersedes any pending conflict (modified) dialog
				openConflict(path, "deleted");
			} else {
				dropTab(path);
				closeTab(path);
			}
		},
		[closeTab, dropTab, openConflict],
	);

	const getLastSavedContentRef = useRef(getLastSavedContent);
	getLastSavedContentRef.current = getLastSavedContent;

	// active タブについて readFile した結果を反映する。clean だったのは readFile を投げた
	// 時点の話なので、ここで取り直す。解決までの間にユーザーが打ち始めていたら、
	// applyExternalReload は editor を remount して打ったばかりの文字を捨ててしまう。
	// dirty なら自分の write でない限りダイアログで問う。
	const reconcileActiveTab = useCallback(
		(path: string, loaded: string) => {
			const current = useWorkspaceStore.getState().tabs.find((t) => t.path === path);
			// 読み込み中にタブが消えた (外部削除で閉じた / workspace 切替)。
			// applyExternalReload は cache を作り直すので、閉じた path の
			// cache が復活して次に開いたとき古い内容が出る。
			if (!current) return;
			if (current.dirty) {
				if (loaded === getLastSavedContentRef.current()) return;
				openConflict(path, "modified");
				return;
			}
			applyExternalReload(path, loaded);
		},
		[applyExternalReload, openConflict],
	);

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
							openConflict(path, "modified");
						})
						.catch((err) => {
							console.error("Failed to read file for conflict check:", err);
						});
				} else {
					readFile(path)
						.then((loaded) => {
							reconcileActiveTab(path, loaded);
						})
						.catch((err) => {
							console.error("Failed to reload file:", err);
						});
				}
			} else {
				// 一度も表示していないタブは cache が無く、次に開いたとき disk から読む。
				if (getCachedContent(path) === null) return;
				readFile(path)
					.then((loaded) => {
						// cache の状態も active かどうかも readFile を投げた時点のもの。
						// 解決までの間にそのタブが active 化されて編集されていると、
						// applyCacheReload は cache を disk の内容で丸ごと置き換えて未保存の
						// 編集を捨てる。適用直前に取り直す (取り直しと適用の間に await が
						// 無いので、ここでの判定は適用時も成り立つ)。
						const state = useWorkspaceStore.getState();
						if (!state.tabs.some((t) => t.path === path)) return;
						if (state.activeTabPath === path) {
							reconcileActiveTab(path, loaded);
							return;
						}
						if (isCachedTabClean(path)) {
							applyCacheReload(path, loaded);
							return;
						}
						// 未保存の編集がある非 active タブ: 今の編集を遮らないようダイアログは
						// 出さず記録だけして、戻ったときに問う。
						markCachedTabConflict(path, loaded);
					})
					.catch((err) => {
						console.error("Failed to reload cached file:", err);
					});
			}
		},
		[
			applyCacheReload,
			isCachedTabClean,
			getCachedContent,
			markCachedTabConflict,
			reconcileActiveTab,
			openConflict,
		],
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
		// autosave は disk の内容を反映し終えるまで止めたままにする。先に解くと、
		// 読み込みが終わる前に未保存の内容が書き込まれ、読み込むのはその内容になる。
		conflictOpenRef.current = false;
		setExternalConflict(null);
		readFile(path)
			.then((loaded) => {
				applyConflictReload(path, loaded);
				if (!conflictOpenRef.current) releaseAutoSave();
			})
			.catch((err) => {
				console.error("Failed to reload file on conflict resolve:", err);
				// File may have been deleted — notify user via the deleted dialog
				openConflict(path, "deleted");
			});
	}, [externalConflict, applyConflictReload, releaseAutoSave, openConflict]);

	const handleConflictKeep = useCallback(() => {
		closeConflict();
	}, [closeConflict]);

	const handleDeletedDirtyDiscard = useCallback(() => {
		if (externalConflict?.type !== "deleted") return;
		const path = externalConflict.path;
		dropTab(path);
		closeTab(path);
		closeConflict();
	}, [externalConflict, closeTab, dropTab, closeConflict]);

	const handleDeletedDirtyKeep = useCallback(() => {
		closeConflict();
	}, [closeConflict]);

	return {
		externalConflict,
		handleConflictReload,
		handleConflictKeep,
		handleDeletedDirtyDiscard,
		handleDeletedDirtyKeep,
	};
}
