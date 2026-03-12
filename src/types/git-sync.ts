export type GitAction = "idle" | "status" | "pull" | "add" | "commit" | "push";
export type SyncMethod = "merge" | "rebase";

export interface GitStatus {
	branch: string;
	changedFilesCount: number;
	conflictFiles: string[];
	hasRemote: boolean;
}

export interface ConflictContent {
	ours: string;
	theirs: string;
}

export interface GitSyncSettings {
	gitSyncEnabled: boolean;
	autoCommitInterval: number;
	autoPullInterval: number;
	autoPushInterval: number;
	pullBeforePush: boolean;
	syncMethod: SyncMethod;
	commitMessage: string;
	autoPullOnStartup: boolean;
}

export const GIT_SYNC_DEFAULTS: GitSyncSettings = {
	gitSyncEnabled: false,
	autoCommitInterval: 10,
	autoPullInterval: 10,
	autoPushInterval: 10,
	pullBeforePush: true,
	syncMethod: "merge",
	commitMessage: "vault backup: {{date}}",
	autoPullOnStartup: false,
};
