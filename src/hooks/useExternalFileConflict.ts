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

	const hideConflict = useCallback(() => {
		conflictOpenRef.current = false;
		setExternalConflict(null);
	}, []);

	const closeConflict = useCallback(() => {
		hideConflict();
		releaseAutoSave();
	}, [hideConflict, releaseAutoSave]);

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
	// 別のダイアログが出ている間に取り出すと、deleted を優先する openConflict が
	// modified を捨てて記録だけが消えるので、閉じてから取り出す (externalConflict を deps に持つ)。
	useEffect(() => {
		if (!activeTabPath || externalConflict) return;
		if (takeCachedConflict(activeTabPath)) {
			openConflict(activeTabPath, "modified");
		}
	}, [activeTabPath, externalConflict, takeCachedConflict, openConflict]);

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

	// readFile の結果をタブへ反映する。タブの有無・active かどうか・dirty かどうかは
	// readFile を投げた時点のものなので、解決したここで取り直して振り分ける (取り直しと
	// 適用の間に await が無いので、ここでの判定は適用時も成り立つ)。
	const reconcileExternalChange = useCallback(
		(path: string, loaded: string) => {
			const state = useWorkspaceStore.getState();
			const current = state.tabs.find((t) => t.path === path);
			// 読み込み中にタブが消えた (外部削除で閉じた / workspace 切替)。
			// applyExternalReload / applyCacheReload は cache を作り直すので、閉じた path の
			// cache が復活して次に開いたとき古い内容が出る。
			if (!current) return;
			if (state.activeTabPath === path) {
				// 解決までの間にユーザーが打ち始めていたら、applyExternalReload は editor を
				// remount して打ったばかりの文字を捨ててしまう。dirty なら自分の write で
				// ない限りダイアログで問う。
				if (current.dirty) {
					if (loaded === getLastSavedContentRef.current()) return;
					openConflict(path, "modified");
					return;
				}
				applyExternalReload(path, loaded);
				return;
			}
			if (isCachedTabClean(path)) {
				applyCacheReload(path, loaded);
				return;
			}
			// 未保存の編集がある非 active タブ: 今の編集を遮らないようダイアログは
			// 出さず記録だけして、戻ったときに問う。
			markCachedTabConflict(path, loaded);
		},
		[applyExternalReload, applyCacheReload, isCachedTabClean, markCachedTabConflict, openConflict],
	);

	const handleExternalFileModified = useCallback(
		(path: string) => {
			const state = useWorkspaceStore.getState();
			if (!state.tabs.some((t) => t.path === path)) return;
			// 一度も表示していない非 active タブは cache が無く、次に開いたとき disk から読む。
			if (path !== state.activeTabPath && getCachedContent(path) === null) return;
			readFile(path)
				.then((loaded) => {
					reconcileExternalChange(path, loaded);
				})
				.catch((err) => {
					console.error("Failed to read externally modified file:", err);
				});
		},
		[getCachedContent, reconcileExternalChange],
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
		// autosave は disk の内容を読み終えるまで止めたままにする。先に解くと、読み込みが
		// 終わる前に未保存の内容が書き込まれ、読み込むのはその内容になる。
		// 解くのは反映の直前。反映の後に解くと、release の scheduleAutoSave が remount 前の
		// 未保存の本文を読んで、反映が "saved" にした状態を "unsaved" で上書きする。
		hideConflict();
		readFile(path)
			.then((loaded) => {
				if (!conflictOpenRef.current) releaseAutoSave();
				// 読み込み中にタブが閉じていたら、applyConflictReload が閉じた path の cache を作り直す。
				if (!useWorkspaceStore.getState().tabs.some((t) => t.path === path)) return;
				applyConflictReload(path, loaded);
			})
			.catch((err) => {
				console.error("Failed to reload file on conflict resolve:", err);
				// File may have been deleted — notify user via the deleted dialog
				openConflict(path, "deleted");
			});
	}, [externalConflict, hideConflict, applyConflictReload, releaseAutoSave, openConflict]);

	const handleDeletedDirtyDiscard = useCallback(() => {
		if (externalConflict?.type !== "deleted") return;
		const path = externalConflict.path;
		dropTab(path);
		closeTab(path);
		closeConflict();
	}, [externalConflict, closeTab, dropTab, closeConflict]);

	return {
		externalConflict,
		handleConflictReload,
		handleConflictKeep: closeConflict,
		handleDeletedDirtyDiscard,
		handleDeletedDirtyKeep: closeConflict,
	};
}
