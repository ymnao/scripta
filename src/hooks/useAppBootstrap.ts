import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { clearWebviewBrowsingData, listDirectory, workspaceSet } from "../lib/commands";
import { loadSettings, saveSetting } from "../lib/store";
import { useGitSyncStore } from "../stores/git-sync";
import { useSettingsStore } from "../stores/settings";
import { useThemeStore } from "../stores/theme";
import { useWorkspaceStore } from "../stores/workspace";

export interface AppBootstrapState {
	/** 永続化された設定の読み込みが終わるまで true。 */
	loading: boolean;
	isNewWindow: boolean;
	sidebarVisible: boolean;
	setSidebarVisible: Dispatch<SetStateAction<boolean>>;
}

export function useAppBootstrap(): AppBootstrapState {
	const setWorkspacePath = useWorkspaceStore((s) => s.setWorkspacePath);
	const hydratePreference = useThemeStore((s) => s.hydratePreference);
	const hydrateSettings = useSettingsStore((s) => s.hydrate);
	const hydrateGitSync = useGitSyncStore((s) => s.hydrate);

	const [loading, setLoading] = useState(true);

	// New windows (opened via Cmd+Shift+N) carry ?newWindow=true and should not
	// restore or persist the workspace path — only theme and sidebar are restored.
	const [isNewWindow] = useState(() =>
		new URLSearchParams(window.location.search).has("newWindow"),
	);
	const [sidebarVisible, setSidebarVisible] = useState(true);

	// Load persisted settings on mount
	useEffect(() => {
		let cancelled = false;

		void (async () => {
			const settings = await loadSettings();
			if (cancelled) return;

			if (!isNewWindow && settings.workspacePath) {
				let registeredOnMain = false;
				try {
					await workspaceSet(settings.workspacePath);
					registeredOnMain = true;
					if (cancelled) return;
					await listDirectory(settings.workspacePath);
					if (cancelled) return;
					setWorkspacePath(settings.workspacePath);
				} catch {
					// 段階別ハンドリング：
					// - workspaceSet 自体の失敗（settings 永続化失敗・未承認扱い等）→
					//   main 側 state は atomic で変化していないので、保存済み workspacePath を
					//   削除してはいけない。何もしない
					// - workspaceSet 成功後の listDirectory 失敗（パス消失・権限喪失等）→
					//   main 側に登録済みなので fail-closed の整合性のため巻き戻す
					// 加えて unmount / window close 後（cancelled）はロールバックしない
					// （ユーザーの保存済み workspacePath を意図せず削除する副作用を防ぐ）
					if (cancelled) return;
					if (registeredOnMain) {
						await workspaceSet(null).catch(() => {});
					}
				}
			}

			if (cancelled) return;
			hydratePreference(settings.themePreference);
			hydrateSettings({
				showLineNumbers: settings.showLineNumbers,
				fontSize: settings.fontSize,
				autoSaveDelay: settings.autoSaveDelay,
				highlightActiveLine: settings.highlightActiveLine,
				fontFamily: settings.fontFamily,
				trimTrailingWhitespace: settings.trimTrailingWhitespace,
				showLinkCards: settings.showLinkCards,
				loadRemoteImages: settings.loadRemoteImages,
				scratchpadVolatile: settings.scratchpadVolatile,
				autoUpdateCheck: settings.autoUpdateCheck,
				fileTreeShowHidden: settings.fileTreeShowHidden,
				fileTreeExcludePatterns: settings.fileTreeExcludePatterns,
				slidePreviewWidthRatio: settings.slidePreviewWidthRatio,
				slideThumbnailsVisible: settings.slideThumbnailsVisible,
			});
			hydrateGitSync({
				gitSyncEnabled: settings.gitSyncEnabled,
				autoCommitInterval: settings.autoCommitInterval,
				autoPullInterval: settings.autoPullInterval,
				autoPushInterval: settings.autoPushInterval,
				pullBeforePush: settings.pullBeforePush,
				syncMethod: settings.syncMethod,
				commitMessage: settings.commitMessage,
				autoPullOnStartup: settings.autoPullOnStartup,
			});
			setSidebarVisible(settings.sidebarVisible);
			clearWebviewBrowsingData().catch((e) => console.warn("clearWebviewBrowsingData:", e));
			setLoading(false);
		})();

		return () => {
			cancelled = true;
		};
	}, [isNewWindow, setWorkspacePath, hydratePreference, hydrateSettings, hydrateGitSync]);

	// workspacePath の永続化は main 側 workspace:set ハンドラが担うため、
	// renderer 側で settings:set を呼ぶ必要はない（settings の workspacePath は
	// reserved key として renderer からの書き込みを拒否する）。

	// Persist sidebar visibility changes (skip while loading to avoid writing back restored values)
	useEffect(() => {
		if (loading) return;
		void saveSetting("sidebarVisible", sidebarVisible);
	}, [sidebarVisible, loading]);

	return { loading, isNewWindow, sidebarVisible, setSidebarVisible };
}
