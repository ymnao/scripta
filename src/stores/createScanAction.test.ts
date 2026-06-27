import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScanAction } from "./createScanAction";

interface TestState {
	_scanId: number;
	loading: boolean;
	items: string[];
	currentKey: string | null;
}

function createTestStore(initial?: Partial<TestState>) {
	let state: TestState = {
		_scanId: 0,
		loading: false,
		items: [],
		currentKey: null,
		...initial,
	};
	const set = (partial: Partial<TestState>) => {
		state = { ...state, ...partial };
	};
	const get = () => state;
	return { set, get };
}

describe("createScanAction", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("success: apply result and clear loading", async () => {
		const { set, get } = createTestStore();
		const api = vi.fn().mockResolvedValue(["a", "b"]);
		const scan = createScanAction<TestState, [string], string[]>({
			api: () => api,
			applyResult: (result) => ({ items: result }),
			errorMessage: "fail",
		})(set, get);

		await scan("/workspace");

		expect(api).toHaveBeenCalledWith("/workspace");
		expect(get().items).toEqual(["a", "b"]);
		expect(get().loading).toBe(false);
		expect(get()._scanId).toBe(1);
	});

	it("error: log and clear loading without applying result", async () => {
		const { set, get } = createTestStore({ items: ["existing"] });
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const api = vi.fn().mockRejectedValue(new Error("boom"));
		const scan = createScanAction<TestState, [], string[]>({
			api: () => api,
			applyResult: (result) => ({ items: result }),
			errorMessage: "failed to scan",
		})(set, get);

		await scan();

		expect(consoleError).toHaveBeenCalledWith("failed to scan", expect.any(Error));
		expect(get().loading).toBe(false);
		expect(get().items).toEqual(["existing"]);
	});

	it("stale scan: older in-flight result is discarded when newer scan finishes first", async () => {
		const { set, get } = createTestStore();

		let resolveFirst: ((v: string[]) => void) | undefined;
		const firstPromise = new Promise<string[]>((r) => {
			resolveFirst = r;
		});
		const api = vi
			.fn<(label: string) => Promise<string[]>>()
			.mockReturnValueOnce(firstPromise)
			.mockResolvedValueOnce(["fresh"]);

		const scan = createScanAction<TestState, [string], string[]>({
			api: () => api,
			applyResult: (result) => ({ items: result }),
			errorMessage: "fail",
		})(set, get);

		const first = scan("first");
		const second = scan("second");

		await second;
		expect(get().items).toEqual(["fresh"]);
		expect(get()._scanId).toBe(2);

		resolveFirst?.(["stale"]);
		await first;
		expect(get().items).toEqual(["fresh"]);
	});

	it("stale scan: older error path does not clear loading set by newer scan", async () => {
		const { set, get } = createTestStore();
		vi.spyOn(console, "error").mockImplementation(() => {});

		let rejectFirst: ((e: Error) => void) | undefined;
		const firstPromise = new Promise<string[]>((_, rej) => {
			rejectFirst = rej;
		});
		let resolveSecond: ((v: string[]) => void) | undefined;
		const secondPromise = new Promise<string[]>((r) => {
			resolveSecond = r;
		});

		const api = vi
			.fn<() => Promise<string[]>>()
			.mockReturnValueOnce(firstPromise)
			.mockReturnValueOnce(secondPromise);

		const scan = createScanAction<TestState, [], string[]>({
			api: () => api,
			applyResult: (result) => ({ items: result }),
			errorMessage: "fail",
		})(set, get);

		const first = scan();
		const second = scan();
		expect(get().loading).toBe(true);

		rejectFirst?.(new Error("old failure"));
		await first;
		// 古い scan の error path は loading を false に上書きしない
		expect(get().loading).toBe(true);

		resolveSecond?.(["ok"]);
		await second;
		expect(get().loading).toBe(false);
		expect(get().items).toEqual(["ok"]);
	});

	it("beforeScan: pre-state mutations are reflected in the final state", async () => {
		const { set, get } = createTestStore({ items: ["stale"], currentKey: "old" });

		const beforeScan = vi.fn<(state: TestState, args: [string]) => Partial<TestState>>(
			(state, [key]) => ({
				currentKey: key,
				...(state.currentKey !== key ? { items: [] } : {}),
			}),
		);

		let resolveApi: ((v: string[]) => void) | undefined;
		const apiPromise = new Promise<string[]>((r) => {
			resolveApi = r;
		});
		const api = vi.fn().mockReturnValueOnce(apiPromise);

		const scan = createScanAction<TestState, [string], string[]>({
			api: () => api,
			applyResult: (result) => ({ items: result }),
			errorMessage: "fail",
			beforeScan,
		})(set, get);

		const promise = scan("new");

		expect(beforeScan).toHaveBeenCalledTimes(1);
		expect(get().currentKey).toBe("new");
		expect(get().items).toEqual([]);
		expect(get().loading).toBe(true);

		resolveApi?.(["fresh"]);
		await promise;
		expect(get().items).toEqual(["fresh"]);
	});

	it("beforeScan: same key keeps items during re-scan", async () => {
		const { set, get } = createTestStore({ items: ["keep"], currentKey: "same" });

		const beforeScan = (state: TestState, [key]: [string]): Partial<TestState> => ({
			currentKey: key,
			...(state.currentKey !== key ? { items: [] } : {}),
		});

		let resolveApi: ((v: string[]) => void) | undefined;
		const apiPromise = new Promise<string[]>((r) => {
			resolveApi = r;
		});
		const api = vi.fn().mockReturnValueOnce(apiPromise);

		const scan = createScanAction<TestState, [string], string[]>({
			api: () => api,
			applyResult: (result) => ({ items: result }),
			errorMessage: "fail",
			beforeScan,
		})(set, get);

		const promise = scan("same");

		expect(get().items).toEqual(["keep"]);
		expect(get().loading).toBe(true);

		resolveApi?.(["fresh"]);
		await promise;
		expect(get().items).toEqual(["fresh"]);
	});

	it("_scanId monotonically increases per call", async () => {
		const { set, get } = createTestStore();
		const api = vi.fn().mockResolvedValue([]);
		const scan = createScanAction<TestState, [], string[]>({
			api: () => api,
			applyResult: (result) => ({ items: result }),
			errorMessage: "fail",
		})(set, get);

		await scan();
		expect(get()._scanId).toBe(1);
		await scan();
		expect(get()._scanId).toBe(2);
		await scan();
		expect(get()._scanId).toBe(3);
	});

	it("respects manually bumped _scanId between calls (e.g. reset)", async () => {
		const { set, get } = createTestStore({ _scanId: 5 });
		const api = vi.fn().mockResolvedValue([]);
		const scan = createScanAction<TestState, [], string[]>({
			api: () => api,
			applyResult: (result) => ({ items: result }),
			errorMessage: "fail",
		})(set, get);

		await scan();
		expect(get()._scanId).toBe(6);

		// 外部 (例えば reset) で _scanId を進めた場合、次の scan はその次から
		set({ _scanId: 10 });
		await scan();
		expect(get()._scanId).toBe(11);
	});
});
