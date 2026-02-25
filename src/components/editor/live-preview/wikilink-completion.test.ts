import { CompletionContext as CC, type CompletionContext } from "@codemirror/autocomplete";
import { describe, expect, it, vi } from "vitest";
import { createTestState } from "./test-helper";

const mockSearchFilenames = vi.fn(() => Promise.resolve([] as string[]));

vi.mock("../../../stores/workspace", () => ({
	useWorkspaceStore: {
		getState: () => ({
			workspacePath: "/workspace",
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

	it("passes query text to searchFilenames", async () => {
		mockSearchFilenames.mockClear();
		mockSearchFilenames.mockResolvedValueOnce([]);
		await wikilinkCompletionSource(createContext("[[not", 5));
		expect(mockSearchFilenames).toHaveBeenCalledWith("/workspace", "not");
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
});
