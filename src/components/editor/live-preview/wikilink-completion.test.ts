import { CompletionContext as CC, type CompletionContext } from "@codemirror/autocomplete";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestState } from "./test-helper";

const mockSearchFilenames = vi.fn(() => Promise.resolve([] as string[]));
let mockFileTreeVersion = 0;
let mockWorkspacePath = "/workspace";

vi.mock("../../../stores/workspace", () => ({
	useWorkspaceStore: {
		getState: () => ({
			get workspacePath() {
				return mockWorkspacePath;
			},
			get fileTreeVersion() {
				return mockFileTreeVersion;
			},
		}),
	},
}));

vi.mock("../../../lib/commands", () => ({
	searchFilenames: (...args: unknown[]) => mockSearchFilenames(...args),
}));

const { wikilinkCompletion, wikilinkCompletionSource } = await import("./wikilink-completion");

function createContext(doc: string, pos: number): CompletionContext {
	const state = createTestState(doc, pos);
	return new CC(state, pos, false);
}

describe("wikilinkCompletion", () => {
	beforeEach(() => {
		mockSearchFilenames.mockClear();
		mockWorkspacePath = "/workspace";
		// Bump version to invalidate cache for each test
		mockFileTreeVersion++;
	});

	it("exports an Extension", () => {
		expect(wikilinkCompletion).toBeDefined();
	});

	it("returns null when cursor is not inside [[", async () => {
		const result = await wikilinkCompletionSource(createContext("hello world", 5));
		expect(result).toBeNull();
	});

	it("returns completions for [[ trigger", async () => {
		mockSearchFilenames.mockResolvedValueOnce(["/workspace/note.md", "/workspace/todo.md"]);
		const result = await wikilinkCompletionSource(createContext("[[", 2));
		expect(result).not.toBeNull();
		expect(result?.options).toHaveLength(2);
		expect(result?.options[0].label).toBe("note");
		expect(result?.options[1].label).toBe("todo");
	});

	it("fetches all files and filters client-side by query", async () => {
		mockSearchFilenames.mockResolvedValueOnce([
			"/workspace/note.md",
			"/workspace/todo.md",
			"/workspace/readme.md",
		]);
		const result = await wikilinkCompletionSource(createContext("[[not", 5));
		expect(mockSearchFilenames).toHaveBeenCalledWith("/workspace", "");
		expect(result?.options).toHaveLength(1);
		expect(result?.options[0].label).toBe("note");
	});

	it("uses cache on subsequent calls with same fileTreeVersion", async () => {
		mockSearchFilenames.mockResolvedValueOnce(["/workspace/note.md"]);
		await wikilinkCompletionSource(createContext("[[", 2));
		expect(mockSearchFilenames).toHaveBeenCalledTimes(1);

		// Same version — should use cache, no new fetch
		const result = await wikilinkCompletionSource(createContext("[[n", 3));
		expect(mockSearchFilenames).toHaveBeenCalledTimes(1);
		expect(result?.options).toHaveLength(1);
	});

	it("invalidates cache when workspacePath changes", async () => {
		mockSearchFilenames.mockResolvedValueOnce(["/workspace/note.md"]);
		await wikilinkCompletionSource(createContext("[[", 2));
		expect(mockSearchFilenames).toHaveBeenCalledTimes(1);

		// Switch workspace (same version but different path)
		mockWorkspacePath = "/other-workspace";
		mockSearchFilenames.mockResolvedValueOnce(["/other-workspace/other.md"]);
		const result = await wikilinkCompletionSource(createContext("[[", 2));
		expect(mockSearchFilenames).toHaveBeenCalledTimes(2);
		expect(result?.options[0].label).toBe("other");
	});

	it("sets from to after [[", async () => {
		mockSearchFilenames.mockResolvedValueOnce(["/workspace/note.md"]);
		const result = await wikilinkCompletionSource(createContext("text [[n", 8));
		expect(result).not.toBeNull();
		expect(result?.from).toBe(7); // position after [[
	});

	it("strips .md from file labels", async () => {
		mockSearchFilenames.mockResolvedValueOnce(["/workspace/sub/my-note.md"]);
		const result = await wikilinkCompletionSource(createContext("[[", 2));
		expect(result?.options[0].label).toBe("my-note");
		expect(result?.options[0].detail).toBe("/workspace/sub/my-note.md");
	});

	it("returns null on searchFilenames failure", async () => {
		mockSearchFilenames.mockRejectedValueOnce(new Error("invoke error"));
		const result = await wikilinkCompletionSource(createContext("[[", 2));
		expect(result).toBeNull();
	});

	it("handles mixed separator paths correctly", async () => {
		mockSearchFilenames.mockResolvedValueOnce(["C:/Users\\docs\\my-note.md"]);
		const result = await wikilinkCompletionSource(createContext("[[", 2));
		expect(result?.options[0].label).toBe("my-note");
	});
});
