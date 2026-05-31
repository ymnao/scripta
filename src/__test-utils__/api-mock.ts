import { vi } from "vitest";
import type { Api } from "../../electron/preload/api";
import { buildScriptaAssetUrl } from "../../electron/preload/scripta-asset-url";

/**
 * `window.api` の全メソッドを `vi.fn()` で埋めたデフォルトモックを返す。
 * テスト側では必要なメソッドのみ `(window.api.<fn> as Mock).mockResolvedValueOnce(...)`
 * 形式で個別に上書きする。
 */
export function createApiMock(): Api {
	return {
		getVersion: vi.fn(() => ""),
		getAppVersion: vi.fn(async () => "0.0.0"),
		closeWindow: vi.fn(async () => {}),
		openConflictWindow: vi.fn(async () => {}),
		onWindowCloseRequested: vi.fn(() => () => {}),
		clearWebviewBrowsingData: vi.fn(async () => {}),

		openExternal: vi.fn(async () => {}),
		showInFolder: vi.fn(async () => {}),
		buildAssetUrl: vi.fn((path: string) => buildScriptaAssetUrl(path)),

		openDirectoryPicker: vi.fn(async () => null),
		showSaveDialog: vi.fn(async () => null),

		workspaceSet: vi.fn(async () => {}),

		readFile: vi.fn(async () => ""),
		writeFile: vi.fn(async () => {}),
		writeNewFile: vi.fn(async () => {}),
		listDirectory: vi.fn(async () => []),
		createFile: vi.fn(async () => {}),
		createDirectory: vi.fn(async () => {}),
		pathExists: vi.fn(async () => false),
		fileExists: vi.fn(async () => false),
		renameEntry: vi.fn(async () => {}),
		deleteEntry: vi.fn(async () => {}),

		startWatcher: vi.fn(async () => {}),
		stopWatcher: vi.fn(async () => {}),
		onFsChange: vi.fn(() => () => {}),
		onWorkspaceReloadTree: vi.fn(() => () => {}),

		searchFiles: vi.fn(async () => []),
		cancelSearch: vi.fn(async () => {}),
		searchFilenames: vi.fn(async () => []),
		scanUnresolvedWikilinks: vi.fn(async () => []),
		cancelWikilinkScan: vi.fn(async () => {}),

		fetchOgp: vi.fn(async () => ({
			title: null,
			description: null,
			image: null,
			siteName: null,
			url: "",
		})),
		exportPdf: vi.fn(async () => {}),
		checkForUpdate: vi.fn(async () => ({
			hasUpdate: false,
			latestVersion: "0.0.0",
			currentVersion: "0.0.0",
			releaseUrl: "",
		})),

		gitCheckAvailable: vi.fn(async () => false),
		gitCheckRepo: vi.fn(async () => false),
		gitStatus: vi.fn(async () => ({
			branch: "",
			changedFilesCount: 0,
			conflictFiles: [],
			hasRemote: false,
		})),
		gitAddAll: vi.fn(async () => {}),
		gitCommit: vi.fn(async () => ""),
		gitPull: vi.fn(async () => ""),
		gitPush: vi.fn(async () => ""),
		gitGetConflictedFiles: vi.fn(async () => []),
		gitGetConflictContent: vi.fn(async () => ({
			ours: "",
			theirs: "",
		})),
		gitResolveConflict: vi.fn(async () => {}),
		gitFinishConflictResolution: vi.fn(async () => ""),
		gitGetLastCommitTime: vi.fn(async () => null),
		emitConflictResolved: vi.fn(async () => {}),
		onConflictResolved: vi.fn(() => () => {}),

		onMenuEvent: vi.fn(() => () => {}),

		settingsGet: vi.fn(async () => undefined),
		settingsSet: vi.fn(async () => {}),
		settingsDelete: vi.fn(async () => {}),
		settingsSave: vi.fn(async () => {}),
	};
}

/** test-setup.ts から `beforeEach` で呼び、各テスト前に `window.api` を初期化する。 */
export function installDefaultApiMock(): void {
	(globalThis as { api?: Api }).api = createApiMock();
}
