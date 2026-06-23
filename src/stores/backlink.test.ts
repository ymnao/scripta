import { afterEach, describe, expect, it, vi } from "vitest";
import type { BacklinkSource } from "../types/wikilink";
import { useBacklinkStore } from "./backlink";

vi.mock("../lib/commands", () => ({
	scanBacklinks: vi.fn(),
}));

describe("useBacklinkStore", () => {
	afterEach(() => {
		useBacklinkStore.setState({
			backlinks: [],
			loading: false,
			currentTargetPath: null,
		});
	});

	it("starts with empty state", () => {
		const state = useBacklinkStore.getState();
		expect(state.backlinks).toEqual([]);
		expect(state.loading).toBe(false);
		expect(state.currentTargetPath).toBe(null);
	});

	it("scan fetches backlinks and records currentTargetPath", async () => {
		const mockLinks: BacklinkSource[] = [
			{
				sourceFile: "/workspace/source.md",
				references: [
					{
						filePath: "/workspace/source.md",
						lineNumber: 1,
						byteOffset: 5,
						lineContent: "See [[target]]",
						contextBefore: [],
						contextAfter: [],
					},
				],
			},
		];
		const { scanBacklinks } = await import("../lib/commands");
		vi.mocked(scanBacklinks).mockResolvedValue(mockLinks);

		await useBacklinkStore.getState().scan("/workspace", "/workspace/target.md");

		const state = useBacklinkStore.getState();
		expect(state.backlinks).toEqual(mockLinks);
		expect(state.loading).toBe(false);
		expect(state.currentTargetPath).toBe("/workspace/target.md");
	});

	it("changing target clears prior backlinks immediately to avoid stale display", async () => {
		useBacklinkStore.setState({
			backlinks: [{ sourceFile: "/workspace/old.md", references: [] }],
			currentTargetPath: "/workspace/foo.md",
		});

		const { scanBacklinks } = await import("../lib/commands");
		let resolveScan: ((v: BacklinkSource[]) => void) | undefined;
		vi.mocked(scanBacklinks).mockReturnValueOnce(
			new Promise<BacklinkSource[]>((r) => {
				resolveScan = r;
			}),
		);

		const scanPromise = useBacklinkStore.getState().scan("/workspace", "/workspace/bar.md");

		expect(useBacklinkStore.getState().backlinks).toEqual([]);
		expect(useBacklinkStore.getState().loading).toBe(true);
		expect(useBacklinkStore.getState().currentTargetPath).toBe("/workspace/bar.md");

		resolveScan?.([]);
		await scanPromise;
	});

	it("same target re-scan keeps prior backlinks until new result arrives", async () => {
		const existing: BacklinkSource[] = [{ sourceFile: "/workspace/old.md", references: [] }];
		useBacklinkStore.setState({
			backlinks: existing,
			currentTargetPath: "/workspace/foo.md",
		});

		const { scanBacklinks } = await import("../lib/commands");
		let resolveScan: ((v: BacklinkSource[]) => void) | undefined;
		vi.mocked(scanBacklinks).mockReturnValueOnce(
			new Promise<BacklinkSource[]>((r) => {
				resolveScan = r;
			}),
		);

		const scanPromise = useBacklinkStore.getState().scan("/workspace", "/workspace/foo.md");

		// 同じ target なので前回結果はちらつきを避けるため保持
		expect(useBacklinkStore.getState().backlinks).toEqual(existing);
		expect(useBacklinkStore.getState().loading).toBe(true);

		const fresh: BacklinkSource[] = [{ sourceFile: "/workspace/new.md", references: [] }];
		resolveScan?.(fresh);
		await scanPromise;
		expect(useBacklinkStore.getState().backlinks).toEqual(fresh);
	});

	it("scan sets loading to false on error", async () => {
		const { scanBacklinks } = await import("../lib/commands");
		vi.mocked(scanBacklinks).mockRejectedValue(new Error("scan failed"));

		await useBacklinkStore.getState().scan("/workspace", "/workspace/foo.md");

		expect(useBacklinkStore.getState().loading).toBe(false);
	});

	it("stale scan result is discarded when newer scan is in flight", async () => {
		const { scanBacklinks } = await import("../lib/commands");
		const staleResult: BacklinkSource[] = [{ sourceFile: "/workspace/stale.md", references: [] }];
		const freshResult: BacklinkSource[] = [{ sourceFile: "/workspace/fresh.md", references: [] }];

		let resolveFirst: ((v: BacklinkSource[]) => void) | undefined;
		const firstPromise = new Promise<BacklinkSource[]>((r) => {
			resolveFirst = r;
		});

		vi.mocked(scanBacklinks).mockReturnValueOnce(firstPromise).mockResolvedValueOnce(freshResult);

		const scan1 = useBacklinkStore.getState().scan("/workspace", "/workspace/foo.md");
		const scan2 = useBacklinkStore.getState().scan("/workspace", "/workspace/foo.md");

		await scan2;
		expect(useBacklinkStore.getState().backlinks).toEqual(freshResult);

		resolveFirst?.(staleResult);
		await scan1;
		expect(useBacklinkStore.getState().backlinks).toEqual(freshResult);
	});

	it("reset clears all state and invalidates in-flight scans", async () => {
		const { scanBacklinks } = await import("../lib/commands");

		const oldResult: BacklinkSource[] = [{ sourceFile: "/workspace/old.md", references: [] }];

		let resolveOld: ((v: BacklinkSource[]) => void) | undefined;
		const oldPromise = new Promise<BacklinkSource[]>((r) => {
			resolveOld = r;
		});
		vi.mocked(scanBacklinks).mockReturnValueOnce(oldPromise);

		const oldScan = useBacklinkStore.getState().scan("/workspace", "/workspace/foo.md");

		useBacklinkStore.getState().reset();
		expect(useBacklinkStore.getState().currentTargetPath).toBe(null);

		// 古い scan が後から resolve しても state は塗り直されない
		resolveOld?.(oldResult);
		await oldScan;
		expect(useBacklinkStore.getState().backlinks).toEqual([]);
		expect(useBacklinkStore.getState().currentTargetPath).toBe(null);
	});
});
