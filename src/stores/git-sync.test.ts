import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { saveAutoCommitInterval, saveCommitMessage, saveGitSyncEnabled } from "../lib/store";
import { GIT_SYNC_DEFAULTS } from "../types/git-sync";
import { useGitSyncStore } from "./git-sync";

describe("useGitSyncStore", () => {
	beforeEach(() => {
		useGitSyncStore.getState().resetRuntime();
		useGitSyncStore.setState({ ...GIT_SYNC_DEFAULTS });
		vi.clearAllMocks();
	});

	it("has correct default settings", () => {
		const state = useGitSyncStore.getState();
		expect(state.gitSyncEnabled).toBe(false);
		expect(state.autoCommitInterval).toBe(10);
		expect(state.syncMethod).toBe("merge");
		expect(state.commitMessage).toBe("vault backup: {{date}}");
	});

	it("has correct default runtime state", () => {
		const state = useGitSyncStore.getState();
		expect(state.gitAvailable).toBe(false);
		expect(state.gitReady).toBe(false);
		expect(state.gitAction).toBe("idle");
		expect(state.offlineMode).toBe(false);
		expect(state.conflictFiles).toEqual([]);
	});

	it("setGitSyncEnabled persists via save function", () => {
		useGitSyncStore.getState().setGitSyncEnabled(true);
		expect(useGitSyncStore.getState().gitSyncEnabled).toBe(true);
		expect(saveGitSyncEnabled).toHaveBeenCalledWith(true);
	});

	it("setAutoCommitInterval persists via save function", () => {
		useGitSyncStore.getState().setAutoCommitInterval(30);
		expect(useGitSyncStore.getState().autoCommitInterval).toBe(30);
		expect(saveAutoCommitInterval).toHaveBeenCalledWith(30);
	});

	it("setCommitMessage persists via save function", () => {
		useGitSyncStore.getState().setCommitMessage("backup: {{date}}");
		expect(useGitSyncStore.getState().commitMessage).toBe("backup: {{date}}");
		expect(saveCommitMessage).toHaveBeenCalledWith("backup: {{date}}");
	});

	it("hydrate sets state without calling save functions", () => {
		useGitSyncStore.getState().hydrate({
			gitSyncEnabled: true,
			autoCommitInterval: 30,
			commitMessage: "custom",
		});

		expect(useGitSyncStore.getState().gitSyncEnabled).toBe(true);
		expect(useGitSyncStore.getState().autoCommitInterval).toBe(30);
		expect(useGitSyncStore.getState().commitMessage).toBe("custom");
		expect(saveGitSyncEnabled).not.toHaveBeenCalled();
		expect(saveAutoCommitInterval).not.toHaveBeenCalled();
		expect(saveCommitMessage).not.toHaveBeenCalled();
	});

	it("resetRuntime resets runtime state but preserves settings", () => {
		useGitSyncStore.getState().setGitSyncEnabled(true);
		useGitSyncStore.getState().setGitAvailable(true);
		useGitSyncStore.getState().setGitReady(true);
		useGitSyncStore.getState().setGitAction("push");
		useGitSyncStore.getState().setBranch("main");

		useGitSyncStore.getState().resetRuntime();

		expect(useGitSyncStore.getState().gitAvailable).toBe(false);
		expect(useGitSyncStore.getState().gitReady).toBe(false);
		expect(useGitSyncStore.getState().gitAction).toBe("idle");
		expect(useGitSyncStore.getState().branch).toBe("");
		expect(useGitSyncStore.getState().gitSyncEnabled).toBe(true);
	});

	it("runtime setters update state without persistence", () => {
		useGitSyncStore.getState().setGitAction("pull");
		expect(useGitSyncStore.getState().gitAction).toBe("pull");

		useGitSyncStore.getState().setConflictFiles(["a.md", "b.md"]);
		expect(useGitSyncStore.getState().conflictFiles).toEqual(["a.md", "b.md"]);

		useGitSyncStore.getState().setOfflineMode(true);
		expect(useGitSyncStore.getState().offlineMode).toBe(true);
	});
});
