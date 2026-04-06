import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { startWatcher, stopWatcher } from "../lib/commands";
import type { FsChangeEvent } from "../types/workspace";
import { useFileWatcher } from "./useFileWatcher";

vi.mock("../lib/commands", () => ({
	startWatcher: vi.fn().mockResolvedValue(undefined),
	stopWatcher: vi.fn().mockResolvedValue(undefined),
}));

type FsChangeCallback = (event: { payload: FsChangeEvent[] }) => void;
let fsChangeCallback: FsChangeCallback | null = null;

vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn().mockImplementation((_name: string, cb: FsChangeCallback) => {
		fsChangeCallback = cb;
		return Promise.resolve(() => {
			fsChangeCallback = null;
		});
	}),
}));

function emitFsChange(events: FsChangeEvent[]) {
	if (fsChangeCallback) {
		fsChangeCallback({ payload: events });
	}
}

describe("useFileWatcher", () => {
	const onTreeChange = vi.fn();
	const onFileModified = vi.fn();
	const onFileDeleted = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		fsChangeCallback = null;
		vi.clearAllMocks();
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
});
