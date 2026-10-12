export type GitAction = "idle" | "status" | "pull" | "add" | "commit" | "push";
export type SyncMethod = "merge" | "rebase";

export interface GitStatus {
	branch: string;
	changedFilesCount: number;
	conflictFiles: string[];
	hasRemote: boolean;
	// merge / rebase / cherry-pick / revert の途中か。
	operationInProgress: boolean;
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
	// 自動同期するブランチ。空文字ならリモートの既定ブランチ → main の順に自動で決める。
	gitSyncBranch: string;
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
	gitSyncBranch: "",
};

// commitMessage の正規化: trim して空文字なら DEFAULTS に fallback。
// load 側 (lib/store.ts) と save 側 (stores/git-sync.ts setCommitMessage) の
// 両方から呼び、ルール drift を防ぐ (単一 SOT)。
export function normalizeCommitMessage(v: unknown): string {
	const trimmed = typeof v === "string" ? v.trim() : "";
	return trimmed.length > 0 ? trimmed : GIT_SYNC_DEFAULTS.commitMessage;
}

// 自動同期を止めている理由（#639）。
export type SyncHalt =
	| { reason: "status-unavailable" }
	| { reason: "no-sync-branch" }
	| { reason: "in-progress" }
	// branch が空文字なのは detached HEAD（rebase の途中を含む）。
	| { reason: "other-branch"; branch: string; syncBranch: string };

// 同期対象のブランチ上にいて、merge / rebase などの途中でなければ null。
export function getSyncHalt(
	status: Pick<GitStatus, "branch" | "operationInProgress">,
	syncBranch: string | null,
): SyncHalt | null {
	if (syncBranch === null) return { reason: "no-sync-branch" };
	// rebase の途中は HEAD が detached なので、ブランチより先に見ないと理由が「別のブランチ」になる。
	if (status.operationInProgress) return { reason: "in-progress" };
	if (status.branch !== syncBranch) {
		return { reason: "other-branch", branch: status.branch, syncBranch };
	}
	return null;
}

export function isSameSyncHalt(a: SyncHalt | null, b: SyncHalt | null): boolean {
	if (a === null || b === null) return a === b;
	if (a.reason !== b.reason) return false;
	if (a.reason === "other-branch" && b.reason === "other-branch") {
		return a.branch === b.branch && a.syncBranch === b.syncBranch;
	}
	return true;
}

export function formatSyncHaltLabel(halt: SyncHalt): string {
	switch (halt.reason) {
		case "status-unavailable":
			return "同期停止中（状態を読めません）";
		case "no-sync-branch":
			return "同期停止中（ブランチ未設定）";
		case "in-progress":
			return "同期停止中（操作の途中）";
		case "other-branch":
			return `同期停止中（${halt.branch || "detached HEAD"}）`;
	}
}

export function formatSyncHaltMessage(halt: SyncHalt): string {
	switch (halt.reason) {
		case "status-unavailable":
			return "Git の状態を読み取れなかったため、同期を止めています。";
		case "no-sync-branch":
			return "同期するブランチを決められないため、同期を止めています。設定の「同期するブランチ」を指定してください。";
		case "in-progress":
			return "merge・rebase・cherry-pick・revert の途中のため、同期を止めています。--continue か --abort で操作を終えると再開します。";
		case "other-branch":
			return `同期するブランチ（${halt.syncBranch}）以外にいるため、同期を止めています。`;
	}
}
