import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { onFsChange, onWorkspaceReloadTree, startWatcher, stopWatcher } from "../lib/commands";
import type { FsChangeEvent } from "../types/workspace";
import { useFileWatcher } from "./useFileWatcher";

vi.mock("../lib/commands", () => ({
	startWatcher: vi.fn().mockResolvedValue(undefined),
	stopWatcher: vi.fn().mockResolvedValue(undefined),
	onFsChange: vi.fn(),
	onWorkspaceReloadTree: vi.fn(),
}));

let fsChangeCallback: ((events: FsChangeEvent[]) => void) | null = null;
let reloadTreeCallback: (() => void) | null = null;

function emitFsChange(events: FsChangeEvent[]) {
	if (fsChangeCallback) {
		fsChangeCallback(events);
	}
}

describe("useFileWatcher", () => {
	const onTreeChange = vi.fn();
	const onFileModified = vi.fn();
	const onFileDeleted = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		fsChangeCallback = null;
		reloadTreeCallback = null;
		vi.clearAllMocks();
		(onFsChange as Mock).mockImplementation((cb: (events: FsChangeEvent[]) => void) => {
			fsChangeCallback = cb;
			return () => {
				fsChangeCallback = null;
			};
		});
		(onWorkspaceReloadTree as Mock).mockImplementation((cb: () => void) => {
			reloadTreeCallback = cb;
			return () => {
				reloadTreeCallback = null;
			};
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("starts and stops watcher on mount/unmount", async () => {
		const { unmount } = renderHook(() =>
			useFileWatcher({
				workspacePath: "/workspace",
				onTreeChange,
				onFileModified,
				onFileDeleted,
			}),
		);

		await vi.advanceTimersByTimeAsync(0);
		expect(startWatcher).toHaveBeenCalledWith("/workspace");

		unmount();
		await vi.advanceTimersByTimeAsync(0);
		expect(stopWatcher).toHaveBeenCalled();
	});

	it("does not start watcher when workspacePath is null", async () => {
		renderHook(() =>
			useFileWatcher({
				workspacePath: null,
				onTreeChange,
				onFileModified,
				onFileDeleted,
			}),
		);

		await vi.advanceTimersByTimeAsync(0);
		expect(startWatcher).not.toHaveBeenCalled();
	});

	it("batches events with 300ms fixed deadline", async () => {
		renderHook(() =>
			useFileWatcher({
				workspacePath: "/workspace",
				onTreeChange,
				onFileModified,
				onFileDeleted,
			}),
		);
		await vi.advanceTimersByTimeAsync(0);

		emitFsChange([{ kind: "modify", path: "/workspace/a.md" }]);

		// Not yet flushed
		expect(onFileModified).not.toHaveBeenCalled();

		vi.advanceTimersByTime(300);

		expect(onFileModified).toHaveBeenCalledWith("/workspace/a.md");
		expect(onTreeChange).toHaveBeenCalled();
	});

	it("deduplicates: create + modify → create (no modify callback)", async () => {
		renderHook(() =>
			useFileWatcher({
				workspacePath: "/workspace",
				onTreeChange,
				onFileModified,
				onFileDeleted,
			}),
		);
		await vi.advanceTimersByTimeAsync(0);

		emitFsChange([
			{ kind: "create", path: "/workspace/a.md" },
			{ kind: "modify", path: "/workspace/a.md" },
		]);
		vi.advanceTimersByTime(300);

		// create + modify → create; no modify or delete callback for this path
		expect(onFileModified).not.toHaveBeenCalled();
		expect(onFileDeleted).not.toHaveBeenCalled();
		expect(onTreeChange).toHaveBeenCalled();
	});

	it("deduplicates: create + delete → removed (no callbacks)", async () => {
		renderHook(() =>
			useFileWatcher({
				workspacePath: "/workspace",
				onTreeChange,
				onFileModified,
				onFileDeleted,
			}),
		);
		await vi.advanceTimersByTimeAsync(0);

		emitFsChange([
			{ kind: "create", path: "/workspace/a.md" },
			{ kind: "delete", path: "/workspace/a.md" },
		]);
		vi.advanceTimersByTime(300);

		// create + delete → entry removed; no per-file callbacks
		expect(onFileModified).not.toHaveBeenCalled();
		expect(onFileDeleted).not.toHaveBeenCalled();
		// Tree refresh still fires
		expect(onTreeChange).toHaveBeenCalled();
	});

	it("deduplicates: delete + create → modify", async () => {
		renderHook(() =>
			useFileWatcher({
				workspacePath: "/workspace",
				onTreeChange,
				onFileModified,
				onFileDeleted,
			}),
		);
		await vi.advanceTimersByTimeAsync(0);

		emitFsChange([
			{ kind: "delete", path: "/workspace/a.md" },
			{ kind: "create", path: "/workspace/a.md" },
		]);
		vi.advanceTimersByTime(300);

		// delete + create → modify
		expect(onFileModified).toHaveBeenCalledWith("/workspace/a.md");
		expect(onFileDeleted).not.toHaveBeenCalled();
	});

	it("restarts watcher when workspacePath changes", async () => {
		const { rerender } = renderHook(
			({ path }) =>
				useFileWatcher({
					workspacePath: path,
					onTreeChange,
					onFileModified,
					onFileDeleted,
				}),
			{ initialProps: { path: "/workspace1" } },
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(startWatcher).toHaveBeenCalledWith("/workspace1");

		(stopWatcher as Mock).mockClear();
		(startWatcher as Mock).mockClear();

		rerender({ path: "/workspace2" });
		await vi.advanceTimersByTimeAsync(0);

		expect(stopWatcher).toHaveBeenCalled();
		expect(startWatcher).toHaveBeenCalledWith("/workspace2");
	});

	it("subscribes before startWatcher to avoid losing early events", async () => {
		// startWatcher を未解決のままにして、IPC 完了前に main から emit が来た状況を再現。
		let resolveStart: () => void = () => {};
		(startWatcher as Mock).mockImplementation(
			() =>
				new Promise<void>((res) => {
					resolveStart = res;
				}),
		);

		renderHook(() =>
			useFileWatcher({
				workspacePath: "/workspace",
				onTreeChange,
				onFileModified,
				onFileDeleted,
			}),
		);

		// effect の同期実行で onFsChange が登録されている（subscribe-first）
		await vi.advanceTimersByTimeAsync(0);
		expect(onFsChange).toHaveBeenCalled();
		expect(fsChangeCallback).not.toBeNull();

		// onFsChange が startWatcher より先に呼ばれた順序を保証
		const onFsChangeOrder = (onFsChange as Mock).mock.invocationCallOrder[0];
		const startWatcherOrder = (startWatcher as Mock).mock.invocationCallOrder[0];
		expect(onFsChangeOrder).toBeLessThan(startWatcherOrder);

		// startWatcher 完了前に main から event が届いてもちゃんと拾える
		emitFsChange([{ kind: "modify", path: "/workspace/early.md" }]);
		vi.advanceTimersByTime(300);
		expect(onFileModified).toHaveBeenCalledWith("/workspace/early.md");

		// あとから startWatcher が解決しても問題ない
		resolveStart();
		await vi.advanceTimersByTimeAsync(0);
	});

	it("removes the listener if startWatcher rejects", async () => {
		(startWatcher as Mock).mockRejectedValueOnce(new Error("Permission denied"));

		renderHook(() =>
			useFileWatcher({
				workspacePath: "/workspace",
				onTreeChange,
				onFileModified,
				onFileDeleted,
			}),
		);
		await vi.advanceTimersByTimeAsync(0);

		// startWatcher が失敗したら listener は外される
		expect(fsChangeCallback).toBeNull();
	});

	it("does not fire callbacks after unmount", async () => {
		const { unmount } = renderHook(() =>
			useFileWatcher({
				workspacePath: "/workspace",
				onTreeChange,
				onFileModified,
				onFileDeleted,
			}),
		);
		await vi.advanceTimersByTimeAsync(0);

		emitFsChange([{ kind: "modify", path: "/workspace/a.md" }]);

		unmount();
		vi.advanceTimersByTime(300);

		// Callbacks should not fire after unmount (cancelled + timer cleared)
		expect(onFileModified).not.toHaveBeenCalled();
		expect(onTreeChange).not.toHaveBeenCalled();
	});

	it("fires onTreeChange when workspace:reload-tree event is received", async () => {
		renderHook(() =>
			useFileWatcher({
				workspacePath: "/workspace",
				onTreeChange,
				onFileModified,
				onFileDeleted,
			}),
		);
		await vi.advanceTimersByTimeAsync(0);

		expect(onWorkspaceReloadTree).toHaveBeenCalled();
		expect(reloadTreeCallback).not.toBeNull();

		reloadTreeCallback?.();
		expect(onTreeChange).toHaveBeenCalledTimes(1);
	});

	it("unsubscribes onWorkspaceReloadTree on unmount", async () => {
		const { unmount } = renderHook(() =>
			useFileWatcher({
				workspacePath: "/workspace",
				onTreeChange,
				onFileModified,
				onFileDeleted,
			}),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(reloadTreeCallback).not.toBeNull();

		unmount();
		expect(reloadTreeCallback).toBeNull();
	});
});
