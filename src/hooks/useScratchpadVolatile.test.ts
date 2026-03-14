import { act, renderHook } from "@testing-library/react";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/commands", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/store", () => ({
	saveScratchpadVolatile: vi.fn(),
}));

const { readFile, writeFile } = await import("../lib/commands");
const { useSettingsStore } = await import("../stores/settings");
const { useScratchpadVolatile } = await import("./useScratchpadVolatile");
const { scratchpadContentCache } = await import("../components/editor/ScratchpadPanel");

const mockedReadFile = readFile as Mock;
const mockedWriteFile = writeFile as Mock;

describe("useScratchpadVolatile", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		localStorage.clear();
		scratchpadContentCache.clear();
		useSettingsStore.setState({ scratchpadVolatile: true });
	});

	afterEach(() => {
		localStorage.clear();
		scratchpadContentCache.clear();
	});

	it("sets last-active-date on first run", async () => {
		mockedReadFile.mockRejectedValue(new Error("Not found"));

		await act(async () => {
			renderHook(() => useScratchpadVolatile("/workspace"));
		});

		expect(localStorage.getItem("scratchpad-last-active-date:/workspace")).toBeTruthy();
	});

	it("does not archive when scratchpadVolatile is false", async () => {
		useSettingsStore.setState({ scratchpadVolatile: false });
		localStorage.setItem("scratchpad-last-active-date:/workspace", "2026-01-01");

		await act(async () => {
			renderHook(() => useScratchpadVolatile("/workspace"));
		});

		expect(mockedReadFile).not.toHaveBeenCalled();
	});

	it("does not archive when date has not changed", async () => {
		const today = new Date();
		const y = today.getFullYear();
		const m = String(today.getMonth() + 1).padStart(2, "0");
		const d = String(today.getDate()).padStart(2, "0");
		localStorage.setItem("scratchpad-last-active-date:/workspace", `${y}-${m}-${d}`);

		await act(async () => {
			renderHook(() => useScratchpadVolatile("/workspace"));
		});

		expect(mockedReadFile).not.toHaveBeenCalled();
	});

	it("archives content when date has changed", async () => {
		localStorage.setItem("scratchpad-last-active-date:/workspace", "2026-01-01");
		mockedReadFile.mockImplementation(async (path: string) => {
			if (path.endsWith("scratchpad.md")) return "old notes";
			throw new Error("Not found");
		});

		await act(async () => {
			renderHook(() => useScratchpadVolatile("/workspace"));
		});

		// Should write archive
		expect(mockedWriteFile).toHaveBeenCalledWith(
			"/workspace/.scripta/scratchpad-archive/2026-01-01.md",
			"old notes",
		);
		// Should clear scratchpad
		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/.scripta/scratchpad.md", "");
	});

	it("appends to existing archive with separator", async () => {
		localStorage.setItem("scratchpad-last-active-date:/workspace", "2026-01-01");
		mockedReadFile.mockImplementation(async (path: string) => {
			if (path.endsWith("scratchpad.md")) return "new notes";
			if (path.endsWith("2026-01-01.md")) return "previous archive";
			throw new Error("Not found");
		});

		await act(async () => {
			renderHook(() => useScratchpadVolatile("/workspace"));
		});

		expect(mockedWriteFile).toHaveBeenCalledWith(
			"/workspace/.scripta/scratchpad-archive/2026-01-01.md",
			"previous archive\n\n---\n\nnew notes",
		);
	});

	it("does not archive empty scratchpad", async () => {
		localStorage.setItem("scratchpad-last-active-date:/workspace", "2026-01-01");
		mockedReadFile.mockImplementation(async (path: string) => {
			if (path.endsWith("scratchpad.md")) return "  \n  ";
			throw new Error("Not found");
		});

		await act(async () => {
			renderHook(() => useScratchpadVolatile("/workspace"));
		});

		// Should not write archive for empty content
		expect(mockedWriteFile).not.toHaveBeenCalledWith(
			expect.stringContaining("scratchpad-archive"),
			expect.anything(),
		);
		// Should not clear already-empty scratchpad
		expect(mockedWriteFile).not.toHaveBeenCalled();
	});

	it("does nothing when workspacePath is null", async () => {
		localStorage.setItem("scratchpad-last-active-date:/workspace", "2026-01-01");

		await act(async () => {
			renderHook(() => useScratchpadVolatile(null));
		});

		expect(mockedReadFile).not.toHaveBeenCalled();
	});

	it("deletes scratchpadContentCache entry when clearing scratchpad", async () => {
		localStorage.setItem("scratchpad-last-active-date:/workspace", "2026-01-01");
		scratchpadContentCache.set("/workspace/.scripta/scratchpad.md", {
			content: "old notes",
			savedContent: "old notes",
		});
		mockedReadFile.mockImplementation(async (path: string) => {
			if (path.endsWith("scratchpad.md")) return "old notes";
			throw new Error("Not found");
		});

		await act(async () => {
			renderHook(() => useScratchpadVolatile("/workspace"));
		});

		expect(scratchpadContentCache.has("/workspace/.scripta/scratchpad.md")).toBe(false);
	});
});
