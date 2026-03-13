import { create } from "zustand";
import {
	saveAutoCommitInterval,
	saveAutoPullInterval,
	saveAutoPullOnStartup,
	saveAutoPushInterval,
	saveCommitMessage,
	saveGitSyncEnabled,
	savePullBeforePush,
	saveSyncMethod,
} from "../lib/store";
import type { GitAction, GitSyncSettings, SyncMethod } from "../types/git-sync";
import { GIT_SYNC_DEFAULTS } from "../types/git-sync";

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
	unpushedCount: number;
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
	setUnpushedCount: (count: number) => void;

	setGitSyncEnabled: (enabled: boolean) => void;
	setAutoCommitInterval: (interval: number) => void;
	setAutoPullInterval: (interval: number) => void;
	setAutoPushInterval: (interval: number) => void;
	setPullBeforePush: (pull: boolean) => void;
	setSyncMethod: (method: SyncMethod) => void;
	setCommitMessage: (message: string) => void;
	setAutoPullOnStartup: (pull: boolean) => void;

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
	unpushedCount: 0,
};

export const useGitSyncStore = create<GitSyncState>()((set) => ({
	...RUNTIME_DEFAULTS,
	...GIT_SYNC_DEFAULTS,

	setGitAvailable: (available: boolean) => set({ gitAvailable: available }),
	setGitReady: (ready: boolean) => set({ gitReady: ready }),
	setGitAction: (action: GitAction) => set({ gitAction: action }),
	setLastCommitTime: (time: string | null) => set({ lastCommitTime: time }),
	setConflictFiles: (files: string[]) => set({ conflictFiles: files }),
	setOfflineMode: (offline: boolean) => set({ offlineMode: offline }),
	setErrorMessage: (message: string | null) => set({ errorMessage: message }),
	setHasRemote: (hasRemote: boolean) => set({ hasRemote }),
	setBranch: (branch: string) => set({ branch }),
	setUnpushedCount: (count: number) => set({ unpushedCount: count }),

	setGitSyncEnabled: (enabled: boolean) => {
		void saveGitSyncEnabled(enabled);
		set({ gitSyncEnabled: enabled });
	},
	setAutoCommitInterval: (interval: number) => {
		void saveAutoCommitInterval(interval);
		set({ autoCommitInterval: interval });
	},
	setAutoPullInterval: (interval: number) => {
		void saveAutoPullInterval(interval);
		set({ autoPullInterval: interval });
	},
	setAutoPushInterval: (interval: number) => {
		void saveAutoPushInterval(interval);
		set({ autoPushInterval: interval });
	},
	setPullBeforePush: (pull: boolean) => {
		void savePullBeforePush(pull);
		set({ pullBeforePush: pull });
	},
	setSyncMethod: (method: SyncMethod) => {
		void saveSyncMethod(method);
		set({ syncMethod: method });
	},
	setCommitMessage: (message: string) => {
		const normalized = message.trim() || GIT_SYNC_DEFAULTS.commitMessage;
		void saveCommitMessage(normalized);
		set({ commitMessage: normalized });
	},
	setAutoPullOnStartup: (pull: boolean) => {
		void saveAutoPullOnStartup(pull);
		set({ autoPullOnStartup: pull });
	},

	hydrate: (values: Partial<GitSyncSettings>) => {
		set(values);
	},
	resetRuntime: () => {
		set(RUNTIME_DEFAULTS);
	},
}));
