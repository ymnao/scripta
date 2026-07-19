import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../stores/workspace";
import { useDebouncedVersionRescan } from "./useDebouncedVersionRescan";

const bumpFileTree = () => {
	act(() => {
		useWorkspaceStore.getState().bumpFileTreeVersion();
	});
};

const bumpContent = () => {
	act(() => {
		useWorkspaceStore.getState().bumpContentVersion();
	});
};

describe("useDebouncedVersionRescan", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useWorkspaceStore.setState({ fileTreeVersion: 0, contentVersion: 0 });
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("fires rescan for a contentVersion bump too (symmetric path)", () => {
		const rescan = vi.fn();
		const cancel = vi.fn().mockResolvedValue(undefined);
		renderHook(() => useDebouncedVersionRescan(rescan, cancel));

		bumpContent();
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(rescan).toHaveBeenCalledTimes(1);
	});

	it("fires rescan 2000ms after a single bump", () => {
		const rescan = vi.fn();
		const cancel = vi.fn().mockResolvedValue(undefined);
		renderHook(() => useDebouncedVersionRescan(rescan, cancel));

		bumpFileTree();
		expect(rescan).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(1999);
		});
		expect(rescan).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(rescan).toHaveBeenCalledTimes(1);
	});

	it("forces rescan at MAX_WAIT_MS (10000ms) when bumps keep resetting the debounce", () => {
		const rescan = vi.fn();
		const cancel = vi.fn().mockResolvedValue(undefined);
		renderHook(() => useDebouncedVersionRescan(rescan, cancel));

		// bump every 900ms so the classic 2000ms debounce never expires.
		// streakStart = t=0. At each bump, delay = min(2000, max(0, 10000 - elapsed)).
		// The forced fire lands exactly at t = streakStart + MAX_WAIT_MS = 10000.
		let t = 0;
		while (t < 9900) {
			bumpFileTree();
			act(() => {
				vi.advanceTimersByTime(900);
			});
			t += 900;
		}
		// t = 9900 now. Next bump computes delay = min(2000, 100) = 100 → fires at t=10000.
		bumpFileTree();
		act(() => {
			vi.advanceTimersByTime(99);
		});
		expect(rescan).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(rescan).toHaveBeenCalledTimes(1);
	});

	it("does not send cancel when timer never fired (bumps keep resetting classic debounce)", () => {
		const rescan = vi.fn();
		const cancel = vi.fn().mockResolvedValue(undefined);
		const { unmount } = renderHook(() => useDebouncedVersionRescan(rescan, cancel));

		bumpFileTree();
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		bumpFileTree();
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		unmount();

		expect(rescan).not.toHaveBeenCalled();
		expect(cancel).not.toHaveBeenCalled();
	});

	it("sends cancel after firing when the effect cleans up", () => {
		const rescan = vi.fn();
		const cancel = vi.fn().mockResolvedValue(undefined);
		const { unmount } = renderHook(() => useDebouncedVersionRescan(rescan, cancel));

		bumpFileTree();
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(rescan).toHaveBeenCalledTimes(1);

		unmount();
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("no-ops while rescan is null", () => {
		const cancel = vi.fn().mockResolvedValue(undefined);
		renderHook(() => useDebouncedVersionRescan(null, cancel));

		bumpFileTree();
		act(() => {
			vi.advanceTimersByTime(5000);
		});
		expect(cancel).not.toHaveBeenCalled();
	});

	it("resets the streak when rescan is disabled mid-streak and re-enabled later", () => {
		const rescan = vi.fn();
		const cancel = vi.fn().mockResolvedValue(undefined);
		const { rerender } = renderHook(
			({ r }: { r: (() => void) | null }) => useDebouncedVersionRescan(r, cancel),
			{ initialProps: { r: rescan as (() => void) | null } },
		);

		// Start a streak, then disable the hook mid-streak.
		bumpFileTree();
		act(() => {
			vi.advanceTimersByTime(500);
		});
		rerender({ r: null });

		// Time passes while disabled (well past MAX_WAIT_MS).
		act(() => {
			vi.advanceTimersByTime(20000);
		});

		// Re-enable and bump. Must follow DEBOUNCE_MS, not fire immediately from a
		// stale streakStart carried over the disabled period.
		rerender({ r: rescan });
		bumpFileTree();
		act(() => {
			vi.advanceTimersByTime(1999);
		});
		expect(rescan).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(rescan).toHaveBeenCalledTimes(1);
	});

	it("resets the streak when rescan identity changes without a version bump", () => {
		const rescan1 = vi.fn();
		const rescan2 = vi.fn();
		const cancel = vi.fn().mockResolvedValue(undefined);
		const { rerender } = renderHook(
			({ r }: { r: () => void }) => useDebouncedVersionRescan(r, cancel),
			{ initialProps: { r: rescan1 } },
		);

		// Start a streak.
		bumpFileTree();
		act(() => {
			vi.advanceTimersByTime(500);
		});

		// Simulate an identity change (e.g., BacklinkPanel switches targetFilePath).
		// The pending timer is cleared but no version bump follows.
		rerender({ r: rescan2 });

		// A long idle period passes.
		act(() => {
			vi.advanceTimersByTime(20000);
		});

		// A new bump must follow the classic DEBOUNCE_MS, not fire immediately due
		// to a stale streakStart from the abandoned streak.
		bumpFileTree();
		act(() => {
			vi.advanceTimersByTime(1999);
		});
		expect(rescan2).not.toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(rescan2).toHaveBeenCalledTimes(1);
		expect(rescan1).not.toHaveBeenCalled();
	});

	it("starts a fresh streak after firing (maxWait window resets)", () => {
		const rescan = vi.fn();
		const cancel = vi.fn().mockResolvedValue(undefined);
		renderHook(() => useDebouncedVersionRescan(rescan, cancel));

		bumpFileTree();
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(rescan).toHaveBeenCalledTimes(1);

		// After firing, the next bump should follow the classic 2000ms debounce
		// (not fire immediately due to a stale streakStart).
		bumpFileTree();
		act(() => {
			vi.advanceTimersByTime(1999);
		});
		expect(rescan).toHaveBeenCalledTimes(1);

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(rescan).toHaveBeenCalledTimes(2);
	});
});
