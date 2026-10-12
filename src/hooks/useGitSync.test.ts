import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("../lib/commands", () => ({
	gitCheckAvailable: vi.fn(),
	gitCheckRepo: vi.fn(),
	gitStatus: vi.fn(),
	gitResolveSyncBranch: vi.fn(),
	gitGetLastCommitTime: vi.fn(),
	gitAddAll: vi.fn(),
	gitCommit: vi.fn(),
	gitPull: vi.fn(),
	gitPush: vi.fn(),
	// Capture-able mock: テストで callback を呼べるよう、最後に登録された
	// handler を `lastConflictHandler` に保持する。
	onConflictResolved: vi.fn((cb: (workspacePath: string) => void) => {
		lastConflictHandler = cb;
		return () => {
			lastConflictHandler = undefined;
		};
	}),
}));

let lastConflictHandler: ((workspacePath: string) => void) | undefined;

vi.mock("../lib/store", () => ({
	saveSetting: vi.fn(),
}));

const {
	gitCheckAvailable,
	gitCheckRepo,
	gitStatus,
	gitResolveSyncBranch,
	gitGetLastCommitTime,
	gitAddAll,
	gitCommit,
	gitPull,
	gitPush,
} = await import("../lib/commands");
const { useGitSync } = await import("./useGitSync");
const { useGitSyncStore } = await import("../stores/git-sync");
const { useToastStore } = await import("../stores/toast");
const { GIT_SYNC_DEFAULTS } = await import("../types/git-sync");

const mockedGitCheckAvailable = gitCheckAvailable as Mock;
const mockedGitCheckRepo = gitCheckRepo as Mock;
const mockedGitStatus = gitStatus as Mock;
const mockedGitResolveSyncBranch = gitResolveSyncBranch as Mock;
const mockedGitGetLastCommitTime = gitGetLastCommitTime as Mock;
const mockedGitAddAll = gitAddAll as Mock;
const mockedGitCommit = gitCommit as Mock;
const mockedGitPull = gitPull as Mock;
const mockedGitPush = gitPush as Mock;

describe("useGitSync", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useGitSyncStore.getState().resetRuntime();
		useGitSyncStore.setState({ ...GIT_SYNC_DEFAULTS });

		// 各 mock を reset してから default を設定する。
		// reset しないと前テストの mockResolvedValueOnce キューが残り、shuffle 順で
		// 別テストの 1 回目の呼び出しが意図せず前テストの Once 値を返してしまう。
		mockedGitCheckAvailable.mockReset().mockResolvedValue(true);
		mockedGitCheckRepo.mockReset().mockResolvedValue(true);
		mockedGitStatus.mockReset().mockResolvedValue({
			branch: "main",
			changedFilesCount: 0,
			conflictFiles: [],
			hasRemote: false,
			operationInProgress: false,
		});
		mockedGitResolveSyncBranch.mockReset().mockResolvedValue("main");
		mockedGitGetLastCommitTime.mockReset().mockResolvedValue("2024-01-01 00:00:00");
		mockedGitAddAll.mockReset().mockResolvedValue(undefined);
		mockedGitCommit.mockReset().mockResolvedValue("committed");
		mockedGitPull.mockReset().mockResolvedValue("");
		mockedGitPush.mockReset().mockResolvedValue("");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("initializes git state on mount with workspace path", async () => {
		renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));

		// Let async init complete
		await vi.advanceTimersByTimeAsync(0);

		const state = useGitSyncStore.getState();
		expect(state.gitAvailable).toBe(true);
		expect(state.gitReady).toBe(true);
		expect(state.branch).toBe("main");
		expect(state.lastCommitTime).toBe("2024-01-01 00:00:00");
	});

	it("sets gitAvailable to false when git is not installed", async () => {
		mockedGitCheckAvailable.mockResolvedValue(false);
		renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));

		await vi.advanceTimersByTimeAsync(0);

		expect(useGitSyncStore.getState().gitAvailable).toBe(false);
		expect(useGitSyncStore.getState().gitReady).toBe(false);
	});

	it("sets gitReady to false when path is not a repo", async () => {
		mockedGitCheckRepo.mockResolvedValue(false);
		renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));

		await vi.advanceTimersByTimeAsync(0);

		expect(useGitSyncStore.getState().gitAvailable).toBe(true);
		expect(useGitSyncStore.getState().gitReady).toBe(false);
	});

	it("resets runtime state when workspace path is null", async () => {
		useGitSyncStore.getState().setGitAvailable(true);
		useGitSyncStore.getState().setGitReady(true);

		renderHook(() => useGitSync({ workspacePath: null }));

		await vi.advanceTimersByTimeAsync(0);

		expect(useGitSyncStore.getState().gitAvailable).toBe(false);
		expect(useGitSyncStore.getState().gitReady).toBe(false);
	});

	it("returns manualSync function", () => {
		const { result } = renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));
		expect(typeof result.current.manualSync).toBe("function");
	});

	it("manualSync triggers commit flow", async () => {
		useGitSyncStore.setState({ gitSyncEnabled: true });

		const { result } = renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));
		await vi.advanceTimersByTimeAsync(0);

		result.current.manualSync();
		await vi.advanceTimersByTimeAsync(0);

		expect(mockedGitAddAll).toHaveBeenCalledWith("/test/workspace", "main");
		expect(mockedGitCommit).toHaveBeenCalled();
	});

	it("continues pull/push when nothing to commit", async () => {
		mockedGitStatus.mockResolvedValue({
			branch: "main",
			changedFilesCount: 0,
			conflictFiles: [],
			hasRemote: true,
		});
		mockedGitCommit.mockRejectedValue(
			Object.assign(new Error("nothing to commit, working tree clean"), {
				kind: "GIT_NOTHING_TO_COMMIT",
			}),
		);
		mockedGitPull.mockResolvedValue("");
		mockedGitPush.mockResolvedValue("");

		useGitSyncStore.setState({ gitSyncEnabled: true, pullBeforePush: true });

		const { result } = renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));
		await vi.advanceTimersByTimeAsync(0);

		mockedGitPull.mockClear();
		mockedGitPush.mockClear();
		result.current.manualSync();
		await vi.advanceTimersByTimeAsync(0);

		// Commit failed with "nothing to commit" but pull/push should still run
		expect(mockedGitPull).toHaveBeenCalled();
		expect(mockedGitPush).toHaveBeenCalled();
	});

	it("manualSync shows error toast when push fails", async () => {
		mockedGitStatus.mockResolvedValue({
			branch: "main",
			changedFilesCount: 0,
			conflictFiles: [],
			hasRemote: true,
		});
		mockedGitCommit.mockRejectedValue(
			Object.assign(new Error("nothing to commit, working tree clean"), {
				kind: "GIT_NOTHING_TO_COMMIT",
			}),
		);
		mockedGitPush.mockRejectedValue(new Error("remote: Permission denied"));

		useGitSyncStore.setState({ gitSyncEnabled: true, pullBeforePush: false });

		const { result } = renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));
		await vi.advanceTimersByTimeAsync(0);

		const addToast = vi.spyOn(useToastStore.getState(), "addToast");
		result.current.manualSync();
		await vi.advanceTimersByTimeAsync(0);

		// Should show error toast, not success toast
		expect(addToast).toHaveBeenCalledWith("error", expect.stringContaining("同期に失敗しました"));
	});

	it("doPull failure refreshes status and detects conflicts", async () => {
		// Setup: repo with remote, pullBeforePush enabled
		const clean = { branch: "main", changedFilesCount: 0, conflictFiles: [], hasRemote: true };
		mockedGitStatus
			// init と、manualSync が commit 前に状態を読み直す分
			.mockResolvedValueOnce(clean)
			.mockResolvedValueOnce(clean)
			// After pull failure, refreshStatus returns conflict files
			.mockResolvedValue({
				branch: "main",
				changedFilesCount: 2,
				conflictFiles: ["file1.md"],
				hasRemote: true,
			});
		mockedGitPull.mockRejectedValue(new Error("CONFLICT (content): Merge conflict in file1.md"));

		useGitSyncStore.setState({
			gitSyncEnabled: true,
			pullBeforePush: true,
			autoPullOnStartup: false,
		});

		const { result } = renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));
		await vi.advanceTimersByTimeAsync(0);

		// Clear call counts accumulated during init to isolate manualSync behaviour
		mockedGitPull.mockClear();
		mockedGitPull.mockRejectedValue(new Error("CONFLICT (content): Merge conflict in file1.md"));
		mockedGitPush.mockClear();

		// Trigger manual sync which does commit → pull → push.
		// queue.enqueue() の戻り値は捨てられているので外から待てない。queue 内で
		// commit → pull(失敗) → refreshStatus と複数 await が連鎖するため、
		// timer を進めて await chain 全体を解決させる。100ms ≪ autoCommit/Pull/Push
		// のデフォルト間隔（10 分）なので interval は発火しない。
		result.current.manualSync();
		await vi.advanceTimersByTimeAsync(100);

		// Pull was called
		expect(mockedGitPull).toHaveBeenCalled();
		// Status was refreshed after pull failure → conflicts detected
		const state = useGitSyncStore.getState();
		expect(state.conflictFiles).toEqual(["file1.md"]);
		// Push must NOT be called after pull failure
		expect(mockedGitPush).not.toHaveBeenCalled();
	});

	it("manualSync shows warning toast during conflicts instead of running", async () => {
		mockedGitStatus.mockResolvedValue({
			branch: "main",
			changedFilesCount: 0,
			conflictFiles: ["conflict.md"],
			hasRemote: true,
		});

		useGitSyncStore.setState({ gitSyncEnabled: true });

		const { result } = renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));
		await vi.advanceTimersByTimeAsync(0);

		// Store should now have conflict files from init
		expect(useGitSyncStore.getState().conflictFiles).toEqual(["conflict.md"]);

		const addToast = vi.spyOn(useToastStore.getState(), "addToast");
		// Clear call counts accumulated during init to isolate manualSync behaviour
		mockedGitAddAll.mockClear();

		result.current.manualSync();
		await vi.advanceTimersByTimeAsync(0);

		// Should show warning, not start sync
		expect(addToast).toHaveBeenCalledWith(
			"warning",
			"コンフリクトを解消してから同期してください。",
		);
		expect(mockedGitAddAll).not.toHaveBeenCalled();
	});

	it("periodic pull reschedules after failure", async () => {
		mockedGitStatus.mockResolvedValue({
			branch: "main",
			changedFilesCount: 0,
			conflictFiles: [],
			hasRemote: true,
		});
		// Pull fails on first call, succeeds on second
		mockedGitPull
			.mockRejectedValueOnce(new Error("Connection timed out"))
			.mockResolvedValueOnce("");

		useGitSyncStore.setState({
			gitSyncEnabled: true,
			autoPullInterval: 1, // 1 minute
			autoCommitInterval: 0,
			autoPushInterval: 0,
		});

		renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));
		await vi.advanceTimersByTimeAsync(0);

		// First pull timer fires → fails
		mockedGitPull.mockClear();
		mockedGitPull
			.mockRejectedValueOnce(new Error("Connection timed out"))
			.mockResolvedValueOnce("");
		await vi.advanceTimersByTimeAsync(60_000);

		expect(mockedGitPull).toHaveBeenCalledTimes(1);

		// Second pull timer should still fire despite first failure
		mockedGitPull.mockClear();
		mockedGitPull.mockResolvedValueOnce("");
		await vi.advanceTimersByTimeAsync(60_000);

		expect(mockedGitPull).toHaveBeenCalledTimes(1);
	});

	it("pausedRef resets when conflicts clear after refreshStatus", async () => {
		// First call: conflicts present
		mockedGitStatus
			.mockResolvedValueOnce({
				branch: "main",
				changedFilesCount: 1,
				conflictFiles: ["file.md"],
				hasRemote: false,
			})
			// Second call: conflicts resolved
			.mockResolvedValueOnce({
				branch: "main",
				changedFilesCount: 0,
				conflictFiles: [],
				hasRemote: false,
			});

		useGitSyncStore.setState({ gitSyncEnabled: true });

		renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));
		await vi.advanceTimersByTimeAsync(0);

		// Conflicts detected → manualSync should be blocked
		expect(useGitSyncStore.getState().conflictFiles).toEqual(["file.md"]);

		// Now simulate conflict resolution: re-render triggers refreshStatus
		// which returns no conflicts
		mockedGitStatus.mockResolvedValue({
			branch: "main",
			changedFilesCount: 0,
			conflictFiles: [],
			hasRemote: false,
		});

		// Re-initialize by changing workspace path
		const { result: result2 } = renderHook(() => useGitSync({ workspacePath: "/test/workspace2" }));
		await vi.advanceTimersByTimeAsync(0);

		// No conflicts → sync should work
		result2.current.manualSync();
		await vi.advanceTimersByTimeAsync(0);

		expect(mockedGitAddAll).toHaveBeenCalled();
	});

	it("periodic pull refreshes status during conflict pause to detect external resolution", async () => {
		// Init: conflicts present, remote available
		mockedGitStatus.mockResolvedValue({
			branch: "main",
			changedFilesCount: 1,
			conflictFiles: ["file.md"],
			hasRemote: true,
		});

		useGitSyncStore.setState({
			gitSyncEnabled: true,
			autoPullInterval: 1, // 1 minute
			autoCommitInterval: 0,
			autoPushInterval: 0,
		});

		renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));
		await vi.advanceTimersByTimeAsync(0);

		// Verify conflicts are detected and pause is active
		expect(useGitSyncStore.getState().conflictFiles).toEqual(["file.md"]);

		// Simulate external conflict resolution: next refreshStatus returns no conflicts
		mockedGitStatus.mockResolvedValue({
			branch: "main",
			changedFilesCount: 0,
			conflictFiles: [],
			hasRemote: true,
		});

		// Advance to pull timer — doPull is paused but should still call refreshStatus
		await vi.advanceTimersByTimeAsync(60_000);

		// Conflicts should now be cleared
		expect(useGitSyncStore.getState().conflictFiles).toEqual([]);
	});

	it("hasRemote=false conflict is detected as resolved via periodic pull timer", async () => {
		// Init: conflicts present, NO remote
		mockedGitStatus.mockResolvedValue({
			branch: "main",
			changedFilesCount: 1,
			conflictFiles: ["file.md"],
			hasRemote: false,
		});

		useGitSyncStore.setState({
			gitSyncEnabled: true,
			autoPullInterval: 1, // 1 minute
			autoCommitInterval: 0,
			autoPushInterval: 0,
		});

		renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));
		await vi.advanceTimersByTimeAsync(0);

		// Verify conflicts are detected
		expect(useGitSyncStore.getState().conflictFiles).toEqual(["file.md"]);

		// Simulate external conflict resolution via CLI
		mockedGitStatus.mockResolvedValue({
			branch: "main",
			changedFilesCount: 0,
			conflictFiles: [],
			hasRemote: false,
		});

		// Advance to pull timer — doPull should still refreshStatus even
		// without remote because pausedRef check is before hasRemote check
		await vi.advanceTimersByTimeAsync(60_000);

		// Conflicts should now be cleared
		expect(useGitSyncStore.getState().conflictFiles).toEqual([]);
	});

	it("ignores conflict-resolved broadcast for a different workspace", async () => {
		// 別 window の解消イベントが broadcast で全 window に届いた時、
		// 自分の workspace と一致しなければ paused をクリアしないことを確認する。
		mockedGitStatus.mockResolvedValue({
			branch: "main",
			changedFilesCount: 1,
			conflictFiles: ["file.md"],
			hasRemote: false,
		});

		useGitSyncStore.setState({ gitSyncEnabled: true });
		renderHook(() => useGitSync({ workspacePath: "/test/workspace-A" }));
		await vi.advanceTimersByTimeAsync(0);

		expect(lastConflictHandler).toBeDefined();
		// 初期化時に refreshStatus が走っているので、その後の呼び出し回数だけ
		// カウントするため一旦リセット。
		mockedGitStatus.mockClear();

		// 別 workspace（B）の解消イベント → 何もしないはず
		lastConflictHandler?.("/test/workspace-B");
		await vi.advanceTimersByTimeAsync(0);
		expect(mockedGitStatus).not.toHaveBeenCalled();

		// 自分の workspace（A）の解消イベント → refreshStatus が走る
		lastConflictHandler?.("/test/workspace-A");
		await vi.advanceTimersByTimeAsync(0);
		expect(mockedGitStatus).toHaveBeenCalledWith("/test/workspace-A");
	});

	it("manualSync re-checks conflicts and proceeds when resolved externally", async () => {
		// Init: conflicts present
		mockedGitStatus
			.mockResolvedValueOnce({
				branch: "main",
				changedFilesCount: 1,
				conflictFiles: ["file.md"],
				hasRemote: false,
			})
			// Second call (from manualSync refreshStatus): conflicts resolved
			.mockResolvedValue({
				branch: "main",
				changedFilesCount: 0,
				conflictFiles: [],
				hasRemote: false,
			});

		useGitSyncStore.setState({ gitSyncEnabled: true });

		const { result } = renderHook(() => useGitSync({ workspacePath: "/test/workspace" }));
		await vi.advanceTimersByTimeAsync(0);

		// Conflicts detected
		expect(useGitSyncStore.getState().conflictFiles).toEqual(["file.md"]);

		// User clicks manual sync — should re-check and discover conflicts are gone
		mockedGitAddAll.mockClear();
		result.current.manualSync();
		await vi.advanceTimersByTimeAsync(0);

		// Should proceed to sync after re-check cleared conflicts
		expect(useGitSyncStore.getState().conflictFiles).toEqual([]);
		expect(mockedGitAddAll).toHaveBeenCalledWith("/test/workspace", "main");
	});
});

describe("useGitSync sync branch gate (#639)", () => {
	const WS = "/test/workspace";

	function statusOn(branch: string, operationInProgress = false) {
		return {
			branch,
			changedFilesCount: 1,
			conflictFiles: [],
			hasRemote: true,
			operationInProgress,
		};
	}

	beforeEach(() => {
		vi.useFakeTimers();
		useGitSyncStore.getState().resetRuntime();
		useGitSyncStore.setState({
			...GIT_SYNC_DEFAULTS,
			gitSyncEnabled: true,
			autoCommitInterval: 1,
			autoPullInterval: 1,
			autoPushInterval: 1,
		});
		useToastStore.setState({ toasts: [] });
		mockedGitCheckAvailable.mockReset().mockResolvedValue(true);
		mockedGitCheckRepo.mockReset().mockResolvedValue(true);
		mockedGitStatus.mockReset().mockResolvedValue(statusOn("work"));
		mockedGitResolveSyncBranch.mockReset().mockResolvedValue("main");
		mockedGitGetLastCommitTime.mockReset().mockResolvedValue(null);
		mockedGitAddAll.mockReset().mockResolvedValue(undefined);
		mockedGitCommit.mockReset().mockResolvedValue("committed");
		mockedGitPull.mockReset().mockResolvedValue("");
		mockedGitPush.mockReset().mockResolvedValue("");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function expectNoSyncOperations(): void {
		expect(mockedGitAddAll).not.toHaveBeenCalled();
		expect(mockedGitCommit).not.toHaveBeenCalled();
		expect(mockedGitPull).not.toHaveBeenCalled();
		expect(mockedGitPush).not.toHaveBeenCalled();
	}

	it("does not commit, pull or push when the timers fire on a work branch", async () => {
		renderHook(() => useGitSync({ workspacePath: WS }));
		await vi.advanceTimersByTimeAsync(60_000);

		expectNoSyncOperations();
		expect(useGitSyncStore.getState().syncHalt).toEqual({
			reason: "other-branch",
			branch: "work",
			syncBranch: "main",
		});
	});

	it("resumes on the next tick after returning to the sync branch", async () => {
		renderHook(() => useGitSync({ workspacePath: WS }));
		await vi.advanceTimersByTimeAsync(60_000);
		expectNoSyncOperations();

		mockedGitStatus.mockResolvedValue(statusOn("main"));
		await vi.advanceTimersByTimeAsync(60_000);

		expect(mockedGitAddAll).toHaveBeenCalledWith(WS, "main");
		expect(mockedGitCommit).toHaveBeenCalledWith(WS, expect.any(String), "main");
		expect(mockedGitPull).toHaveBeenCalledWith(WS, "merge", "main");
		expect(mockedGitPush).toHaveBeenCalledWith(WS, "main");
		expect(useGitSyncStore.getState().syncHalt).toBeNull();
	});

	it("does not sync on the sync branch while a merge or rebase is in progress", async () => {
		mockedGitStatus.mockResolvedValue(statusOn("main", true));
		renderHook(() => useGitSync({ workspacePath: WS }));
		await vi.advanceTimersByTimeAsync(60_000);

		expectNoSyncOperations();
		expect(useGitSyncStore.getState().syncHalt).toEqual({ reason: "in-progress" });
	});

	it("reports a rebase (detached HEAD) as an operation in progress", async () => {
		mockedGitStatus.mockResolvedValue(statusOn("", true));
		renderHook(() => useGitSync({ workspacePath: WS }));
		await vi.advanceTimersByTimeAsync(0);

		expect(useGitSyncStore.getState().syncHalt).toEqual({ reason: "in-progress" });
	});

	it("does not sync when the sync branch cannot be resolved", async () => {
		mockedGitStatus.mockResolvedValue(statusOn("main"));
		mockedGitResolveSyncBranch.mockResolvedValue(null);
		renderHook(() => useGitSync({ workspacePath: WS }));
		await vi.advanceTimersByTimeAsync(60_000);

		expectNoSyncOperations();
		expect(useGitSyncStore.getState().syncHalt).toEqual({ reason: "no-sync-branch" });
	});

	it("passes the configured sync branch to the resolver", async () => {
		useGitSyncStore.setState({ gitSyncBranch: "notes" });
		renderHook(() => useGitSync({ workspacePath: WS }));
		await vi.advanceTimersByTimeAsync(0);

		expect(mockedGitResolveSyncBranch).toHaveBeenCalledWith(WS, "notes");
	});

	it("pulls on startup on the sync branch", async () => {
		mockedGitStatus.mockResolvedValue(statusOn("main"));
		useGitSyncStore.setState({
			autoPullOnStartup: true,
			autoCommitInterval: 0,
			autoPullInterval: 0,
			autoPushInterval: 0,
		});
		renderHook(() => useGitSync({ workspacePath: WS }));
		await vi.advanceTimersByTimeAsync(0);

		expect(mockedGitPull).toHaveBeenCalledWith(WS, "merge", "main");
	});

	it("halts and tells why when the status cannot be read", async () => {
		const { result } = renderHook(() => useGitSync({ workspacePath: WS }));
		await vi.advanceTimersByTimeAsync(0);
		mockedGitStatus.mockRejectedValue(new Error("status failed"));

		result.current.manualSync();
		await vi.advanceTimersByTimeAsync(100);

		expectNoSyncOperations();
		expect(useGitSyncStore.getState().syncHalt).toEqual({ reason: "status-unavailable" });
		expect(useToastStore.getState().toasts).toContainEqual(
			expect.objectContaining({
				type: "warning",
				message: "Git の状態を読み取れなかったため、同期を止めています。",
			}),
		);
	});

	it("re-reads the status as soon as the sync branch setting changes", async () => {
		renderHook(() => useGitSync({ workspacePath: WS }));
		await vi.advanceTimersByTimeAsync(0);
		mockedGitResolveSyncBranch
			.mockClear()
			.mockImplementation(async (_path: string, configured: string) => configured || "main");

		useGitSyncStore.getState().setGitSyncBranch("work");
		await vi.advanceTimersByTimeAsync(0);

		expect(mockedGitResolveSyncBranch).toHaveBeenCalledWith(WS, "work");
		expect(useGitSyncStore.getState().syncHalt).toBeNull();
	});

	it("does not pull on startup on a work branch", async () => {
		useGitSyncStore.setState({
			autoPullOnStartup: true,
			autoCommitInterval: 0,
			autoPullInterval: 0,
			autoPushInterval: 0,
		});
		renderHook(() => useGitSync({ workspacePath: WS }));
		await vi.advanceTimersByTimeAsync(0);

		expect(mockedGitPull).not.toHaveBeenCalled();
	});

	it("manualSync on a work branch warns instead of syncing", async () => {
		const { result } = renderHook(() => useGitSync({ workspacePath: WS }));
		await vi.advanceTimersByTimeAsync(0);

		result.current.manualSync();
		await vi.advanceTimersByTimeAsync(100);

		expectNoSyncOperations();
		expect(useToastStore.getState().toasts).toContainEqual(
			expect.objectContaining({
				type: "warning",
				message: "同期するブランチ（main）以外にいるため、同期を止めています。",
			}),
		);
	});

	it("treats a main-side branch mismatch as a halt, not as an error", async () => {
		// renderer の判定の後、main の実行前にブランチが切り替わったケース。
		mockedGitStatus
			.mockResolvedValueOnce(statusOn("main"))
			.mockResolvedValueOnce(statusOn("main"))
			.mockResolvedValue(statusOn("work"));
		mockedGitAddAll.mockRejectedValue(
			Object.assign(new Error("HEAD is on work"), { kind: "GIT_BRANCH_MISMATCH" }),
		);
		const { result } = renderHook(() => useGitSync({ workspacePath: WS }));
		await vi.advanceTimersByTimeAsync(0);

		result.current.manualSync();
		await vi.advanceTimersByTimeAsync(100);

		expect(mockedGitAddAll).toHaveBeenCalledTimes(1);
		expect(mockedGitCommit).not.toHaveBeenCalled();
		expect(useGitSyncStore.getState().errorMessage).toBeNull();
		expect(useToastStore.getState().toasts.map((t) => t.type)).not.toContain("error");
		expect(useGitSyncStore.getState().syncHalt).toEqual({
			reason: "other-branch",
			branch: "work",
			syncBranch: "main",
		});
	});
});
