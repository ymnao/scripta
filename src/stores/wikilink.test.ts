import { afterEach, describe, expect, it, vi } from "vitest";
import { useWikilinkStore } from "./wikilink";

vi.mock("../lib/commands", () => ({
	scanUnresolvedWikilinks: vi.fn(),
}));

describe("useWikilinkStore", () => {
	afterEach(() => {
		// Reset store state
		useWikilinkStore.setState({
			unresolvedLinks: [],
			drafts: {},
			loading: false,
			sortBy: "name",
			createTarget: null,
		});
	});

	it("starts with empty state", () => {
		const state = useWikilinkStore.getState();
		expect(state.unresolvedLinks).toEqual([]);
		expect(state.drafts).toEqual({});
		expect(state.loading).toBe(false);
		expect(state.sortBy).toBe("name");
	});

	it("scan fetches unresolved links", async () => {
		const mockLinks = [
			{
				pageName: "missing-page",
				references: [
					{
						filePath: "/workspace/note.md",
						lineNumber: 1,
						byteOffset: 5,
						lineContent: "See [[missing-page]]",
						contextBefore: [],
						contextAfter: [],
					},
				],
			},
		];

		const { scanUnresolvedWikilinks } = await import("../lib/commands");
		vi.mocked(scanUnresolvedWikilinks).mockResolvedValue(mockLinks);

		await useWikilinkStore.getState().scan("/workspace");

		const state = useWikilinkStore.getState();
		expect(state.unresolvedLinks).toEqual(mockLinks);
		expect(state.loading).toBe(false);
	});

	it("scan sets loading to false on error", async () => {
		const { scanUnresolvedWikilinks } = await import("../lib/commands");
		vi.mocked(scanUnresolvedWikilinks).mockRejectedValue(new Error("scan failed"));

		await useWikilinkStore.getState().scan("/workspace");

		const state = useWikilinkStore.getState();
		expect(state.unresolvedLinks).toEqual([]);
		expect(state.loading).toBe(false);
	});

	it("setDraft and getDraft", () => {
		const store = useWikilinkStore.getState();
		store.setDraft("page-a", "draft content");

		expect(useWikilinkStore.getState().getDraft("page-a")).toBe("draft content");
		expect(useWikilinkStore.getState().getDraft("nonexistent")).toBe("");
	});

	it("removeDraft removes a draft", () => {
		const store = useWikilinkStore.getState();
		store.setDraft("page-a", "content");
		store.setDraft("page-b", "other content");

		store.removeDraft("page-a");

		expect(useWikilinkStore.getState().getDraft("page-a")).toBe("");
		expect(useWikilinkStore.getState().getDraft("page-b")).toBe("other content");
	});

	it("setSortBy changes sort order", () => {
		useWikilinkStore.getState().setSortBy("count");
		expect(useWikilinkStore.getState().sortBy).toBe("count");

		useWikilinkStore.getState().setSortBy("name");
		expect(useWikilinkStore.getState().sortBy).toBe("name");
	});

	it("setDraft updates existing draft", () => {
		const store = useWikilinkStore.getState();
		store.setDraft("page-a", "first");
		store.setDraft("page-a", "updated");

		expect(useWikilinkStore.getState().getDraft("page-a")).toBe("updated");
	});

	it("stale scan result is discarded when a newer scan is in flight", async () => {
		const { scanUnresolvedWikilinks } = await import("../lib/commands");

		const staleResult = [{ pageName: "stale", references: [] }];
		const freshResult = [{ pageName: "fresh", references: [] }];

		// First scan: slow (resolves after second scan)
		let resolveFirst: ((v: typeof staleResult) => void) | undefined;
		const firstPromise = new Promise<typeof staleResult>((r) => {
			resolveFirst = r;
		});

		vi.mocked(scanUnresolvedWikilinks)
			.mockReturnValueOnce(firstPromise)
			.mockResolvedValueOnce(freshResult);

		// Start first scan (slow)
		const scan1 = useWikilinkStore.getState().scan("/workspace");
		// Start second scan (fast) — should bump scanId
		const scan2 = useWikilinkStore.getState().scan("/workspace");

		// Second scan completes first
		await scan2;
		expect(useWikilinkStore.getState().unresolvedLinks).toEqual(freshResult);

		// First scan completes late — should be discarded
		resolveFirst?.(staleResult);
		await scan1;
		expect(useWikilinkStore.getState().unresolvedLinks).toEqual(freshResult);
	});

	it("reset clears all state and invalidates in-flight scans", async () => {
		const store = useWikilinkStore.getState();
		store.setDraft("page-a", "draft");
		store.setCreateTarget("page-b", []);
		useWikilinkStore.setState({ unresolvedLinks: [{ pageName: "x", references: [] }] });

		store.reset();

		const state = useWikilinkStore.getState();
		expect(state.unresolvedLinks).toEqual([]);
		expect(state.drafts).toEqual({});
		expect(state.createTarget).toBeNull();
		expect(state.loading).toBe(false);
	});

	it("reset followed by scan uses new data, not stale in-flight result", async () => {
		const { scanUnresolvedWikilinks } = await import("../lib/commands");

		const oldResult = [{ pageName: "old-page", references: [] }];
		const newResult = [{ pageName: "new-page", references: [] }];

		// Old scan: slow
		let resolveOld: ((v: typeof oldResult) => void) | undefined;
		const oldPromise = new Promise<typeof oldResult>((r) => {
			resolveOld = r;
		});

		vi.mocked(scanUnresolvedWikilinks)
			.mockReturnValueOnce(oldPromise)
			.mockResolvedValueOnce(newResult);

		// Start scan for old workspace
		const oldScan = useWikilinkStore.getState().scan("/old-workspace");

		// Workspace switch: reset + new scan
		useWikilinkStore.getState().reset();
		const newScan = useWikilinkStore.getState().scan("/new-workspace");

		// New scan completes
		await newScan;
		expect(useWikilinkStore.getState().unresolvedLinks).toEqual(newResult);

		// Old scan completes late — must be discarded
		resolveOld?.(oldResult);
		await oldScan;
		expect(useWikilinkStore.getState().unresolvedLinks).toEqual(newResult);
	});

	it("setCreateTarget and clearCreateTarget", () => {
		const store = useWikilinkStore.getState();
		expect(store.createTarget).toBeNull();

		store.setCreateTarget("new-page", [
			{
				filePath: "/workspace/note.md",
				lineNumber: 1,
				byteOffset: 1,
				lineContent: "[[new-page]]",
				contextBefore: [],
				contextAfter: [],
			},
		]);

		const target = useWikilinkStore.getState().createTarget;
		expect(target?.pageName).toBe("new-page");
		expect(target?.references).toHaveLength(1);

		store.clearCreateTarget();
		expect(useWikilinkStore.getState().createTarget).toBeNull();
	});
});
