import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { writeFile } from "../lib/commands";

vi.mock("../lib/commands", () => ({
	writeFile: vi.fn(),
}));

vi.mock("../stores/toast", () => {
	const addToast = vi.fn().mockReturnValue("toast-1");
	return {
		useToastStore: {
			getState: () => ({ addToast }),
			__mockAddToast: addToast,
		},
	};
});

vi.mock("../lib/store", () => ({
	saveShowLineNumbers: vi.fn(),
	saveFontSize: vi.fn(),
	saveAutoSaveDelay: vi.fn(),
	saveIndentSize: vi.fn(),
	saveHighlightActiveLine: vi.fn(),
	saveFontFamily: vi.fn(),
	saveTrimTrailingWhitespace: vi.fn(),
}));

const { useAutoSave } = await import("./useAutoSave");
const { useSettingsStore } = await import("../stores/settings");

const mockedWriteFile = writeFile as Mock;

describe("useAutoSave", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockedWriteFile.mockResolvedValue(undefined);
		// Reset to default trimTrailingWhitespace
		useSettingsStore.setState({ trimTrailingWhitespace: true });
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("starts with saved status", () => {
		const { result } = renderHook(() => useAutoSave("test.md", "initial"));
		expect(result.current.saveStatus).toBe("saved");
	});

	it("transitions to unsaved when content changes", () => {
		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });
		expect(result.current.saveStatus).toBe("unsaved");
	});

	it("auto-saves after debounce period", async () => {
		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });
		expect(mockedWriteFile).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "changed\n");
		expect(result.current.saveStatus).toBe("saved");
	});

	it("saveNow cancels debounce and saves immediately", async () => {
		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });
		expect(result.current.saveStatus).toBe("unsaved");

		await act(async () => {
			result.current.saveNow();
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "changed\n");
		expect(result.current.saveStatus).toBe("saved");

		// Verify debounce timer doesn't fire a second save
		mockedWriteFile.mockClear();
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it("skips save when content matches lastSaved", async () => {
		const { result } = renderHook(() => useAutoSave("test.md", "initial"));

		result.current.markSaved("initial");

		await act(async () => {
			result.current.saveNow();
		});

		expect(mockedWriteFile).not.toHaveBeenCalled();
		expect(result.current.saveStatus).toBe("saved");
	});

	it("markSaved updates lastSaved and sets saved status", () => {
		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		act(() => {
			result.current.markSaved("initial");
		});

		expect(result.current.saveStatus).toBe("saved");

		// Content matching lastSaved should not trigger unsaved
		rerender({ content: "initial" });
		expect(result.current.saveStatus).toBe("saved");
	});

	it("transitions to error on save failure", async () => {
		mockedWriteFile.mockRejectedValue("Permission denied (os error 13)");

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});

		expect(result.current.saveStatus).toBe("error");
	});

	it("resets from error to unsaved on next edit", async () => {
		mockedWriteFile.mockRejectedValue("Permission denied (os error 13)");

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(result.current.saveStatus).toBe("error");

		mockedWriteFile.mockResolvedValue(undefined);

		rerender({ content: "changed again" });
		expect(result.current.saveStatus).toBe("unsaved");
	});

	it("resets debounce timer on rapid edits", async () => {
		mockedWriteFile.mockClear();

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		act(() => {
			result.current.markSaved("initial");
		});

		rerender({ content: "edit1" });

		await act(async () => {
			vi.advanceTimersByTime(1500);
		});
		expect(mockedWriteFile).not.toHaveBeenCalled();

		rerender({ content: "edit2" });

		await act(async () => {
			vi.advanceTimersByTime(1500);
		});
		expect(mockedWriteFile).not.toHaveBeenCalled();

		await act(async () => {
			vi.advanceTimersByTime(500);
		});
		expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "edit2\n");
	});

	it("flushes pending changes to old path when filePath changes", async () => {
		const { result, rerender } = renderHook(
			({ filePath, content }) => useAutoSave(filePath, content),
			{ initialProps: { filePath: "a.md", content: "initial" } },
		);

		act(() => {
			result.current.markSaved("initial");
		});

		// Edit content for file A
		rerender({ filePath: "a.md", content: "edited A" });
		expect(result.current.saveStatus).toBe("unsaved");

		// Switch to file B — should flush "edited A" to "a.md"
		await act(async () => {
			rerender({ filePath: "b.md", content: "edited A" });
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("a.md", "edited A\n");
		expect(mockedWriteFile).not.toHaveBeenCalledWith("b.md", expect.anything());
		expect(result.current.saveStatus).toBe("saved");
	});

	it("shows error when flush save fails on file switch", async () => {
		const { result, rerender } = renderHook(
			({ filePath, content }) => useAutoSave(filePath, content),
			{ initialProps: { filePath: "a.md", content: "initial" } },
		);

		act(() => {
			result.current.markSaved("initial");
		});

		// Edit content for file A
		rerender({ filePath: "a.md", content: "edited A" });

		// Make flush save fail
		mockedWriteFile.mockRejectedValueOnce(new Error("disk full"));

		// Switch to file B — flush should fail
		await act(async () => {
			rerender({ filePath: "b.md", content: "edited A" });
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("a.md", "edited A\n");
		expect(result.current.saveStatus).toBe("error");
	});

	it("does not save to old path when content is unchanged on switch", async () => {
		const { result, rerender } = renderHook(
			({ filePath, content }) => useAutoSave(filePath, content),
			{ initialProps: { filePath: "a.md", content: "initial" } },
		);

		act(() => {
			result.current.markSaved("initial");
		});

		mockedWriteFile.mockClear();

		// Switch without editing — no save should occur
		await act(async () => {
			rerender({ filePath: "b.md", content: "initial" });
		});

		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it("cancels pending debounce on filePath change", async () => {
		const { result, rerender } = renderHook(
			({ filePath, content }) => useAutoSave(filePath, content),
			{ initialProps: { filePath: "a.md", content: "initial" } },
		);

		act(() => {
			result.current.markSaved("initial");
		});

		// Edit to start debounce timer
		rerender({ filePath: "a.md", content: "edited" });
		expect(result.current.saveStatus).toBe("unsaved");

		mockedWriteFile.mockClear();

		// Switch file — flush happens immediately, debounce cancelled
		await act(async () => {
			rerender({ filePath: "b.md", content: "edited" });
		});

		expect(mockedWriteFile).toHaveBeenCalledTimes(1);
		expect(mockedWriteFile).toHaveBeenCalledWith("a.md", "edited\n");

		mockedWriteFile.mockClear();

		// Advance past debounce — should NOT fire a save to "b.md"
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it("ignores stale save completion when a newer save is in flight", async () => {
		let resolveA!: () => void;
		let resolveB!: () => void;
		mockedWriteFile
			.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						resolveA = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						resolveB = resolve;
					}),
			);

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		act(() => {
			result.current.markSaved("initial");
		});

		// Save A starts (content "v1")
		rerender({ content: "v1" });
		await act(async () => {
			result.current.saveNow();
		});
		expect(result.current.saveStatus).toBe("saving");

		// Save B starts before A completes (content "v2")
		rerender({ content: "v2" });
		await act(async () => {
			result.current.saveNow();
		});
		expect(result.current.saveStatus).toBe("saving");

		// Save A completes late — should be ignored
		await act(async () => {
			resolveA();
		});
		expect(result.current.saveStatus).toBe("saving");

		// Save B completes — should update to saved
		await act(async () => {
			resolveB();
		});
		expect(result.current.saveStatus).toBe("saved");
	});

	it("saveNow returns true on successful save", async () => {
		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });

		let saved!: boolean;
		await act(async () => {
			saved = await result.current.saveNow();
		});

		expect(saved).toBe(true);
		expect(result.current.saveStatus).toBe("saved");
	});

	it("saveNow returns false on save failure", async () => {
		mockedWriteFile.mockRejectedValue("Permission denied (os error 13)");

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });

		let saved!: boolean;
		await act(async () => {
			saved = await result.current.saveNow();
		});

		expect(saved).toBe(false);
		expect(result.current.saveStatus).toBe("error");
	});

	it("saveNow returns true when content is already saved (no-op)", async () => {
		mockedWriteFile.mockClear();

		const { result } = renderHook(() => useAutoSave("test.md", "initial"));

		result.current.markSaved("initial");

		let saved!: boolean;
		await act(async () => {
			saved = await result.current.saveNow();
		});

		expect(saved).toBe(true);
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it("serializes writes so saveNow always writes after in-flight auto-save", async () => {
		const writeOrder: string[] = [];
		let resolveAutoSave!: () => void;

		// First call (auto-save): slow, manually resolved
		mockedWriteFile.mockImplementationOnce(
			(_path: string, content: string) =>
				new Promise<void>((resolve) => {
					writeOrder.push(content);
					resolveAutoSave = resolve;
				}),
		);
		// Second call (saveNow): resolves immediately
		mockedWriteFile.mockImplementationOnce((_path: string, content: string) => {
			writeOrder.push(content);
			return Promise.resolve();
		});

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		act(() => {
			result.current.markSaved("initial");
		});

		// Trigger auto-save with "v1"
		rerender({ content: "v1" });
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		// Auto-save writeFile("v1") is now in-flight (pending)
		expect(writeOrder).toEqual(["v1\n"]);

		// User edits to "v2" and calls saveNow (chains on inflightRef)
		rerender({ content: "v2" });
		act(() => {
			result.current.saveNow().catch(() => {});
		});

		// writeFile for "v2" should NOT have been called yet (blocked by in-flight auto-save)
		expect(writeOrder).toEqual(["v1\n"]);

		// Resolve the auto-save — unblocks saveNow's chained write
		await act(async () => {
			resolveAutoSave();
		});

		// "v2" should have been written AFTER "v1" — guaranteed last-write-wins
		expect(writeOrder).toEqual(["v1\n", "v2\n"]);
		expect(result.current.saveStatus).toBe("saved");
	});

	it("trims trailing whitespace when trimTrailingWhitespace is true", async () => {
		useSettingsStore.setState({ trimTrailingWhitespace: true });

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "hello world   \nfoo\t\t\n" });

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "hello world\nfoo\n");
		expect(result.current.saveStatus).toBe("saved");
	});

	it("preserves trailing whitespace when trimTrailingWhitespace is false", async () => {
		useSettingsStore.setState({ trimTrailingWhitespace: false });

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "hello world   \nfoo\t\t" });

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});

		// Trailing whitespace preserved, but final newline still guaranteed
		expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "hello world   \nfoo\t\t\n");
		expect(result.current.saveStatus).toBe("saved");
	});

	it("does not re-save when processed content matches saved content", async () => {
		useSettingsStore.setState({ trimTrailingWhitespace: true });
		mockedWriteFile.mockClear();

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		// Edit to content that differs only by trailing whitespace
		rerender({ content: "initial   " });

		// After processing, "initial   " → "initial\n" which matches saved content
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});

		// Should NOT trigger a save since processed content matches
		expect(mockedWriteFile).not.toHaveBeenCalled();
		expect(result.current.saveStatus).toBe("saved");
	});

	it("schedules auto-retry on transient save error", async () => {
		mockedWriteFile.mockRejectedValueOnce("Connection timed out").mockResolvedValue(undefined);

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });

		// Trigger auto-save
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(result.current.saveStatus).toBe("retrying");
		expect(mockedWriteFile).toHaveBeenCalledTimes(1);

		// Retry should fire after 5 seconds
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(mockedWriteFile).toHaveBeenCalledTimes(2);
		expect(result.current.saveStatus).toBe("saved");
	});

	it("does not retry on non-transient save error", async () => {
		mockedWriteFile.mockRejectedValue("Not found: /test.md");

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(result.current.saveStatus).toBe("error");

		mockedWriteFile.mockClear();

		// Advance past retry window — no retry should occur
		await act(async () => {
			vi.advanceTimersByTime(10000);
		});
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it("shows toast when retry fails with non-transient error mid-retry", async () => {
		const { useToastStore } = await import("../stores/toast");
		const mockAddToast = (useToastStore as unknown as { __mockAddToast: Mock }).__mockAddToast;
		mockAddToast.mockClear();

		// 1st attempt: transient error → retry scheduled
		// 2nd attempt: non-transient error → should show toast
		mockedWriteFile
			.mockRejectedValueOnce("Connection timed out")
			.mockRejectedValueOnce("Permission denied (os error 13)");

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });

		// Trigger auto-save (fails with transient error → retrying)
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(result.current.saveStatus).toBe("retrying");

		// Retry fires after 5s (fails with non-transient error → error + toast)
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(result.current.saveStatus).toBe("error");
		expect(mockAddToast).toHaveBeenCalledWith(
			"error",
			expect.stringContaining("ファイルの保存に失敗しました"),
		);
	});

	it("cancels retry when content changes", async () => {
		mockedWriteFile.mockRejectedValueOnce("Connection timed out").mockResolvedValue(undefined);

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });

		// Trigger auto-save (fails)
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(result.current.saveStatus).toBe("retrying");

		mockedWriteFile.mockClear();

		// Edit again before retry fires — retry should be cancelled
		rerender({ content: "changed again" });
		expect(result.current.saveStatus).toBe("unsaved");

		// Advance past original retry time — the new debounce save should fire, not the retry
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "changed again\n");
	});

	it("saveNow cancels pending retry timer", async () => {
		mockedWriteFile.mockRejectedValueOnce("Connection timed out").mockResolvedValue(undefined);

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });

		// Trigger auto-save (fails with transient error → retry scheduled at 5s)
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(result.current.saveStatus).toBe("retrying");

		const callsAfterError = mockedWriteFile.mock.calls.length;

		// Call saveNow before the retry fires — should cancel the retry
		await act(async () => {
			await result.current.saveNow();
		});
		expect(result.current.saveStatus).toBe("saved");
		expect(mockedWriteFile.mock.calls.length - callsAfterError).toBe(1);

		// Advance past retry window — no extra save should fire
		mockedWriteFile.mockClear();
		await act(async () => {
			vi.advanceTimersByTime(10000);
		});
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it("schedules follow-up save when content changed during write", async () => {
		let resolveSave!: () => void;
		mockedWriteFile.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveSave = resolve;
				}),
		);

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		act(() => {
			result.current.markSaved("initial");
		});

		// Edit to "v1" and trigger auto-save
		rerender({ content: "v1" });
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(mockedWriteFile).toHaveBeenCalledTimes(1);
		expect(result.current.saveStatus).toBe("saving");

		// While write is in-flight, content reverts to saved value
		rerender({ content: "initial" });

		// Then changes to "v2"
		rerender({ content: "v2" });

		// Content effect sees "v2" !== lastSavedRef ("initial\n") → sets timer.
		// But now resolve the in-flight save for "v1" — lastSavedRef becomes "v1\n".
		mockedWriteFile.mockResolvedValue(undefined);
		await act(async () => {
			resolveSave();
		});

		// The success handler detects contentRef ("v2") !== saved ("v1\n")
		// and sets status to "unsaved", scheduling a follow-up timer.
		expect(result.current.saveStatus).toBe("unsaved");

		// Advance past follow-up timer
		mockedWriteFile.mockClear();
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});

		expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "v2\n");
		expect(result.current.saveStatus).toBe("saved");
	});

	it("does not schedule follow-up when content matches after write", async () => {
		let resolveSave!: () => void;
		mockedWriteFile.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveSave = resolve;
				}),
		);

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		act(() => {
			result.current.markSaved("initial");
		});

		// Edit and trigger save
		rerender({ content: "v1" });
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});

		// Content stays at "v1" while save completes
		mockedWriteFile.mockClear();
		await act(async () => {
			resolveSave();
		});

		// No mismatch → status should be "saved", no follow-up
		expect(result.current.saveStatus).toBe("saved");

		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it("stops retrying after max retries and shows toast", async () => {
		const { useToastStore } = await import("../stores/toast");
		const mockAddToast = (useToastStore as unknown as { __mockAddToast: Mock }).__mockAddToast;
		mockAddToast.mockClear();

		mockedWriteFile.mockRejectedValue("Connection timed out");

		const { result, rerender } = renderHook(({ content }) => useAutoSave("test.md", content), {
			initialProps: { content: "initial" },
		});

		result.current.markSaved("initial");

		rerender({ content: "changed" });

		// Initial save fails — status should be "retrying"
		await act(async () => {
			vi.advanceTimersByTime(2000);
		});
		expect(result.current.saveStatus).toBe("retrying");

		const callsAfterInitial = mockedWriteFile.mock.calls.length;

		// Advance through all retry windows: 5s + 10s + 20s + 40s (extra margin)
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		await act(async () => {
			vi.advanceTimersByTime(10000);
		});
		await act(async () => {
			vi.advanceTimersByTime(20000);
		});

		const callsAfterRetries = mockedWriteFile.mock.calls.length;
		// Should have retried exactly 3 times (MAX_SAVE_RETRIES)
		expect(callsAfterRetries - callsAfterInitial).toBe(3);

		// After max retries, status should be "error" and toast should be shown
		expect(result.current.saveStatus).toBe("error");
		expect(mockAddToast).toHaveBeenCalledWith(
			"error",
			expect.stringContaining("ファイルの保存に失敗しました"),
		);

		// No more retries after max
		mockedWriteFile.mockClear();
		await act(async () => {
			vi.advanceTimersByTime(40000);
		});
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	describe("IME composition deferral", () => {
		beforeEach(() => {
			mockedWriteFile.mockClear();
		});

		it("defers auto-save during IME composition and saves after composition ends", async () => {
			const composing = { value: true };
			const isComposing = () => composing.value;

			const { result, rerender } = renderHook(
				({ content }) => useAutoSave("test.md", content, isComposing),
				{ initialProps: { content: "initial" } },
			);

			result.current.markSaved("initial");
			rerender({ content: "日本語" });

			// Advance past debounce period
			await act(async () => {
				vi.advanceTimersByTime(2000);
			});
			// Save deferred because composing
			expect(mockedWriteFile).not.toHaveBeenCalled();

			// Advance one defer cycle — still composing
			await act(async () => {
				vi.advanceTimersByTime(200);
			});
			expect(mockedWriteFile).not.toHaveBeenCalled();

			// End composition
			composing.value = false;

			// Next defer cycle should trigger save
			await act(async () => {
				vi.advanceTimersByTime(200);
			});
			expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "日本語\n");
			expect(result.current.saveStatus).toBe("saved");
		});

		it("defers follow-up save during IME composition", async () => {
			let resolveSave!: () => void;
			mockedWriteFile.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						resolveSave = resolve;
					}),
			);

			const composing = { value: false };
			const isComposing = () => composing.value;

			const { result, rerender } = renderHook(
				({ content }) => useAutoSave("test.md", content, isComposing),
				{ initialProps: { content: "initial" } },
			);

			act(() => {
				result.current.markSaved("initial");
			});

			// Edit to "v1" and trigger auto-save
			rerender({ content: "v1" });
			await act(async () => {
				vi.advanceTimersByTime(2000);
			});
			expect(mockedWriteFile).toHaveBeenCalledTimes(1);

			// While write is in-flight, content changes to "v2"
			rerender({ content: "v2" });

			// Start composing before save completes
			composing.value = true;

			// Resolve the in-flight save — follow-up should be scheduled
			mockedWriteFile.mockResolvedValue(undefined);
			await act(async () => {
				resolveSave();
			});
			expect(result.current.saveStatus).toBe("unsaved");

			mockedWriteFile.mockClear();

			// Advance past follow-up delay — composing, so save should be deferred
			await act(async () => {
				vi.advanceTimersByTime(2000);
			});
			expect(mockedWriteFile).not.toHaveBeenCalled();

			// End composition
			composing.value = false;

			// Defer cycle should trigger save
			await act(async () => {
				vi.advanceTimersByTime(200);
			});
			expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "v2\n");
			expect(result.current.saveStatus).toBe("saved");
		});

		it("saveNow saves immediately even during IME composition", async () => {
			const isComposing = () => true;

			const { result, rerender } = renderHook(
				({ content }) => useAutoSave("test.md", content, isComposing),
				{ initialProps: { content: "initial" } },
			);

			result.current.markSaved("initial");
			rerender({ content: "changed" });

			await act(async () => {
				await result.current.saveNow();
			});

			expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "changed\n");
			expect(result.current.saveStatus).toBe("saved");
		});

		it("cancels composition defer timer on content change", async () => {
			const composing = { value: true };
			const isComposing = () => composing.value;

			const { result, rerender } = renderHook(
				({ content }) => useAutoSave("test.md", content, isComposing),
				{ initialProps: { content: "initial" } },
			);

			result.current.markSaved("initial");
			rerender({ content: "v1" });

			// Advance past debounce — enters composition defer loop
			await act(async () => {
				vi.advanceTimersByTime(2000);
			});
			expect(mockedWriteFile).not.toHaveBeenCalled();

			// Content changes — should cancel defer and start new debounce
			composing.value = false;
			rerender({ content: "v2" });

			// Old defer timer should not fire (cancelled by content effect cleanup)
			await act(async () => {
				vi.advanceTimersByTime(200);
			});
			expect(mockedWriteFile).not.toHaveBeenCalled();

			// New debounce should fire after full delay
			await act(async () => {
				vi.advanceTimersByTime(2000);
			});
			expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "v2\n");
		});

		it("defers error retry during IME composition", async () => {
			mockedWriteFile.mockRejectedValueOnce("Connection timed out").mockResolvedValue(undefined);

			const composing = { value: false };
			const isComposing = () => composing.value;

			const { result, rerender } = renderHook(
				({ content }) => useAutoSave("test.md", content, isComposing),
				{ initialProps: { content: "initial" } },
			);

			result.current.markSaved("initial");
			rerender({ content: "changed" });

			// Trigger auto-save (fails with transient error → retry scheduled at 5s)
			await act(async () => {
				vi.advanceTimersByTime(2000);
			});
			expect(result.current.saveStatus).toBe("retrying");

			mockedWriteFile.mockClear();

			// Start composing before retry fires
			composing.value = true;

			// Advance past retry delay — composing, so save should be deferred
			await act(async () => {
				vi.advanceTimersByTime(5000);
			});
			expect(mockedWriteFile).not.toHaveBeenCalled();

			// End composition
			composing.value = false;

			// Defer cycle should trigger save
			await act(async () => {
				vi.advanceTimersByTime(200);
			});
			expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "changed\n");
			expect(result.current.saveStatus).toBe("saved");
		});

		it("defers flush on file switch during IME composition without touching saveStatus", async () => {
			const composing = { value: true };
			const isComposing = () => composing.value;
			const onFlushComplete = vi.fn();

			const { result, rerender } = renderHook(
				({ filePath, content }) => useAutoSave(filePath, content, isComposing, onFlushComplete),
				{ initialProps: { filePath: "a.md", content: "initial" } },
			);

			act(() => {
				result.current.markSaved("initial");
			});

			// Edit content for file A
			rerender({ filePath: "a.md", content: "edited A" });

			// Switch to file B while composing — flush should be deferred
			await act(async () => {
				rerender({ filePath: "b.md", content: "edited A" });
			});
			expect(mockedWriteFile).not.toHaveBeenCalled();

			// Mark new file as saved (simulates file load for tab B)
			act(() => {
				result.current.markSaved("content B");
			});
			expect(result.current.saveStatus).toBe("saved");

			// End composition
			composing.value = false;

			// Defer cycle should flush old file silently
			await act(async () => {
				vi.advanceTimersByTime(200);
			});
			expect(mockedWriteFile).toHaveBeenCalledWith("a.md", "edited A\n");
			// Status must still reflect the current tab (B), not the old flush
			expect(result.current.saveStatus).toBe("saved");
			// onFlushComplete called with old path and raw content
			expect(onFlushComplete).toHaveBeenCalledWith("a.md", "edited A");
		});
	});
});
