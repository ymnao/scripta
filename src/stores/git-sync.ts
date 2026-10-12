import { create } from "zustand";
import { saveSetting } from "../lib/store";
import type { GitAction, GitSyncSettings, SyncHalt, SyncMethod } from "../types/git-sync";
import { GIT_SYNC_DEFAULTS, isSameSyncHalt, normalizeCommitMessage } from "../types/git-sync";
import { createPersistedSetter } from "./store-helpers";

interface GitSyncRuntimeState {
	gitAvailable: boolean;
	gitReady: boolean;
	gitAction: GitAction;
	lastCommitTime: string | null;
	conflictFiles: string[];
	offlineMode: boolean;
	errorMessage: string | null;
	hasRemote: boolean;
	branch: string;
	// 自動同期を止めている理由。null は止めていない（または未判定）。
	syncHalt: SyncHalt | null;
}

interface GitSyncState extends GitSyncRuntimeState, GitSyncSettings {
	setGitAvailable: (available: boolean) => void;
	setGitReady: (ready: boolean) => void;
	setGitAction: (action: GitAction) => void;
	setLastCommitTime: (time: string | null) => void;
	setConflictFiles: (files: string[]) => void;
	setOfflineMode: (offline: boolean) => void;
	setErrorMessage: (message: string | null) => void;
	setHasRemote: (hasRemote: boolean) => void;
	setBranch: (branch: string) => void;
	setSyncHalt: (halt: SyncHalt | null) => void;

	setGitSyncEnabled: (enabled: boolean) => void;
	setAutoCommitInterval: (interval: number) => void;
	setAutoPullInterval: (interval: number) => void;
	setAutoPushInterval: (interval: number) => void;
	setPullBeforePush: (pull: boolean) => void;
	setSyncMethod: (method: SyncMethod) => void;
	setCommitMessage: (message: string) => void;
	setAutoPullOnStartup: (pull: boolean) => void;
	setGitSyncBranch: (branch: string) => void;

	hydrate: (values: Partial<GitSyncSettings>) => void;
	resetRuntime: () => void;
}

const RUNTIME_DEFAULTS: GitSyncRuntimeState = {
	gitAvailable: false,
	gitReady: false,
	gitAction: "idle",
	lastCommitTime: null,
	conflictFiles: [],
	offlineMode: false,
	errorMessage: null,
	hasRemote: false,
	branch: "",
	syncHalt: null,
};

export const useGitSyncStore = create<GitSyncState>()((set) => {
	const persist = createPersistedSetter<GitSyncSettings>(set, saveSetting);
	return {
		...RUNTIME_DEFAULTS,
		...GIT_SYNC_DEFAULTS,

		setGitAvailable: (available: boolean) =>
			set((s) => (s.gitAvailable === available ? s : { gitAvailable: available })),
		setGitReady: (ready: boolean) => set((s) => (s.gitReady === ready ? s : { gitReady: ready })),
		setGitAction: (action: GitAction) =>
			set((s) => (s.gitAction === action ? s : { gitAction: action })),
		setLastCommitTime: (time: string | null) =>
			set((s) => (s.lastCommitTime === time ? s : { lastCommitTime: time })),
		setConflictFiles: (files: string[]) => set({ conflictFiles: files }),
		setOfflineMode: (offline: boolean) =>
			set((s) => (s.offlineMode === offline ? s : { offlineMode: offline })),
		setErrorMessage: (message: string | null) =>
			set((s) => (s.errorMessage === message ? s : { errorMessage: message })),
		setHasRemote: (hasRemote: boolean) =>
			set((s) => (s.hasRemote === hasRemote ? s : { hasRemote })),
		setBranch: (branch: string) => set((s) => (s.branch === branch ? s : { branch })),
		setSyncHalt: (halt: SyncHalt | null) =>
			set((s) => (isSameSyncHalt(s.syncHalt, halt) ? s : { syncHalt: halt })),

		setGitSyncEnabled: persist("gitSyncEnabled"),
		setAutoCommitInterval: persist("autoCommitInterval"),
		setAutoPullInterval: persist("autoPullInterval"),
		setAutoPushInterval: persist("autoPushInterval"),
		setPullBeforePush: persist("pullBeforePush"),
		setSyncMethod: persist("syncMethod"),
		setCommitMessage: persist("commitMessage", normalizeCommitMessage),
		setAutoPullOnStartup: persist("autoPullOnStartup"),
		setGitSyncBranch: persist("gitSyncBranch", (v) => v.trim()),

		hydrate: (values: Partial<GitSyncSettings>) => {
			set(values);
		},
		resetRuntime: () => {
			set(RUNTIME_DEFAULTS);
		},
	};
});
