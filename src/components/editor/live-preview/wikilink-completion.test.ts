import { describe, expect, it, vi } from "vitest";

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

// Import after mocks are set up
const { wikilinkCompletion } = await import("./wikilink-completion");

describe("wikilinkCompletion", () => {
	it("exports an Extension", () => {
		expect(wikilinkCompletion).toBeDefined();
	});

	it("searchFilenames mock is callable", async () => {
		mockSearchFilenames.mockResolvedValueOnce(["/workspace/note.md"]);
		const result = await mockSearchFilenames("/workspace", "note");
		expect(result).toEqual(["/workspace/note.md"]);
	});
});
