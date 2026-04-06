import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("../lib/commands", () => ({
	gitCheckAvailable: vi.fn(),
	gitCheckRepo: vi.fn(),
	gitStatus: vi.fn(),
	gitGetLastCommitTime: vi.fn(),
	gitAddAll: vi.fn(),
	gitCommit: vi.fn(),
	gitPull: vi.fn(),
	gitPush: vi.fn(),
}));

vi.mock("../lib/store", () => ({
	saveGitSyncEnabled: vi.fn(),
	saveAutoCommitInterval: vi.fn(),
	saveAutoPullInterval: vi.fn(),
	saveAutoPushInterval: vi.fn(),
	savePullBeforePush: vi.fn(),
	saveSyncMethod: vi.fn(),
	saveCommitMessage: vi.fn(),
	saveAutoPullOnStartup: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockResolvedValue(() => {}),
}));

const {
	gitCheckAvailable,
	gitCheckRepo,
	gitStatus,
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

		mockedGitCheckAvailable.mockResolvedValue(true);
		mockedGitCheckRepo.mockResolvedValue(true);
		mockedGitStatus.mockResolvedValue({
			branch: "main",
			changedFilesCount: 0,
			conflictFiles: [],
			hasRemote: false,
		});
		mockedGitGetLastCommitTime.mockResolvedValue("2024-01-01 00:00:00");
		mockedGitAddAll.mockResolvedValue(undefined);
		mockedGitCommit.mockResolvedValue("committed");
		mockedGitPull.mockResolvedValue("");
		mockedGitPush.mockResolvedValue("");
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

		expect(mockedGitAddAll).toHaveBeenCalledWith("/test/workspace");
		expect(mockedGitCommit).toHaveBeenCalled();
	});

	it("continues pull/push when nothing to commit", async () => {
		mockedGitStatus.mockResolvedValue({
			branch: "main",
			changedFilesCount: 0,
			conflictFiles: [],
			hasRemote: true,
		});
		mockedGitCommit.mockRejectedValue(new Error("nothing to commit, working tree clean"));
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
		mockedGitCommit.mockRejectedValue(new Error("nothing to commit, working tree clean"));
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
		mockedGitStatus
			.mockResolvedValueOnce({
				branch: "main",
				changedFilesCount: 0,
				conflictFiles: [],
				hasRemote: true,
			})
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

		// Trigger manual sync which does commit → pull → push
		result.current.manualSync();
		await vi.advanceTimersByTimeAsync(0);

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
		expect(mockedGitAddAll).toHaveBeenCalledWith("/test/workspace");
	});
});
