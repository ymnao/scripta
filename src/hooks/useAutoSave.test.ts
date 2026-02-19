import { act, renderHook } from "@testing-library/react";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "../lib/commands";

vi.mock("../lib/commands", () => ({
	writeFile: vi.fn(),
}));

const { useAutoSave } = await import("./useAutoSave");

const mockedWriteFile = writeFile as Mock;

describe("useAutoSave", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockedWriteFile.mockResolvedValue(undefined);
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

		expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "changed");
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

		expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "changed");
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
		mockedWriteFile.mockRejectedValue(new Error("write error"));

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
		mockedWriteFile.mockRejectedValue(new Error("write error"));

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
		expect(mockedWriteFile).toHaveBeenCalledWith("test.md", "edit2");
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
});
