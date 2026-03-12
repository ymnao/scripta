import { renderHook } from "@testing-library/react";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { gitCheckAvailable, gitCheckRepo, gitStatus, gitGetLastCommitTime, gitAddAll, gitCommit } =
	await import("../lib/commands");
const { useGitSync } = await import("./useGitSync");
const { useGitSyncStore } = await import("../stores/git-sync");
const { GIT_SYNC_DEFAULTS } = await import("../types/git-sync");

const mockedGitCheckAvailable = gitCheckAvailable as Mock;
const mockedGitCheckRepo = gitCheckRepo as Mock;
const mockedGitStatus = gitStatus as Mock;
const mockedGitGetLastCommitTime = gitGetLastCommitTime as Mock;
const mockedGitAddAll = gitAddAll as Mock;
const mockedGitCommit = gitCommit as Mock;

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
});
