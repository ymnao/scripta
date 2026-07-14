import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAsyncDerived } from "./useAsyncDerived";

/**
 * 制御可能な Promise。resolve / reject を外部から発火し、
 * useAsyncDerived の async 完了タイミングを厳密に観測する。
 */
function createControllablePromise<T>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("useAsyncDerived", () => {
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		errorSpy.mockRestore();
	});

	it("初回描画では initial を返す (async 未完了)", () => {
		const { promise } = createControllablePromise<string>();
		const { result } = renderHook(() => useAsyncDerived(["k"], "sync", () => promise));
		expect(result.current).toBe("sync");
	});

	it("async resolve で値を上書きする", async () => {
		const ctrl = createControllablePromise<string>();
		const { result } = renderHook(() => useAsyncDerived(["k"], "sync", () => ctrl.promise));
		expect(result.current).toBe("sync");
		await act(async () => {
			ctrl.resolve("async");
			await ctrl.promise;
		});
		expect(result.current).toBe("async");
	});

	it("deps 変更後も前回の async 成功値を保持し続ける (keepPrevious)", async () => {
		let ctrl = createControllablePromise<string>();
		const { result, rerender } = renderHook(
			({ dep }) => useAsyncDerived([dep], "sync", () => ctrl.promise),
			{ initialProps: { dep: "a" } },
		);
		await act(async () => {
			ctrl.resolve("value-A");
			await ctrl.promise;
		});
		expect(result.current).toBe("value-A");

		// deps 変更 → 新 async 起動、resolve 前は前回値を保持
		ctrl = createControllablePromise<string>();
		rerender({ dep: "b" });
		expect(result.current).toBe("value-A");

		await act(async () => {
			ctrl.resolve("value-B");
			await ctrl.promise;
		});
		expect(result.current).toBe("value-B");
	});

	it("stale な (旧 deps の) resolve は最新結果を上書きしない", async () => {
		let ctrlA: ReturnType<typeof createControllablePromise<string>>;
		let ctrlB: ReturnType<typeof createControllablePromise<string>>;
		ctrlA = createControllablePromise<string>();
		const { result, rerender } = renderHook(
			({ dep, ctrl }) => useAsyncDerived([dep], "sync", () => ctrl.promise),
			{ initialProps: { dep: "a", ctrl: ctrlA } },
		);
		// deps を切り替えてから旧 → 新 の順で resolve
		ctrlB = createControllablePromise<string>();
		rerender({ dep: "b", ctrl: ctrlB });
		await act(async () => {
			ctrlB.resolve("new");
			await ctrlB.promise;
		});
		expect(result.current).toBe("new");
		// ここで旧 Promise を後から resolve しても最新値は変わらない
		await act(async () => {
			ctrlA.resolve("stale");
			await ctrlA.promise;
		});
		expect(result.current).toBe("new");
	});

	it("async reject 時は console.error を記録し、直前の成功値を保持する", async () => {
		let ctrl = createControllablePromise<string>();
		const { result, rerender } = renderHook(
			({ dep }) => useAsyncDerived([dep], "sync", () => ctrl.promise),
			{ initialProps: { dep: "a" } },
		);
		await act(async () => {
			ctrl.resolve("ok");
			await ctrl.promise;
		});
		expect(result.current).toBe("ok");

		ctrl = createControllablePromise<string>();
		rerender({ dep: "b" });
		await act(async () => {
			ctrl.reject(new Error("boom"));
			// microtask flush
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(result.current).toBe("ok"); // 前回値を保持
		expect(errorSpy).toHaveBeenCalled();
	});

	it("初回で reject した場合は initial を保持し、console.error を出す", async () => {
		const ctrl = createControllablePromise<string>();
		const { result } = renderHook(() => useAsyncDerived(["k"], "sync", () => ctrl.promise));
		await act(async () => {
			ctrl.reject(new Error("boom"));
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(result.current).toBe("sync");
		expect(errorSpy).toHaveBeenCalled();
	});
});
