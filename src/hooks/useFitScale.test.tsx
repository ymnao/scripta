import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFitScale } from "./useFitScale";

type RoCallback = (entries: ResizeObserverEntry[]) => void;

/**
 * ResizeObserver / requestAnimationFrame を掌握できる制御可能な spy 群を差し込む。
 * useFitScale の rAF coalesce と cleanup の副作用を jsdom 上で観測するため。
 */
function installControllableEnv() {
	const observed: Element[] = [];
	const disconnected: { count: number } = { count: 0 };
	const cancelled: number[] = [];
	let rafId = 0;
	let pending: FrameRequestCallback | null = null;
	let observerCb: RoCallback | null = null;

	const OriginalRO = globalThis.ResizeObserver;
	class MockRO {
		constructor(cb: RoCallback) {
			observerCb = cb;
		}
		observe(el: Element) {
			observed.push(el);
		}
		unobserve() {}
		disconnect() {
			disconnected.count++;
		}
	}
	globalThis.ResizeObserver = MockRO as unknown as typeof ResizeObserver;

	const rafSpy = vi
		.spyOn(globalThis, "requestAnimationFrame")
		.mockImplementation((cb: FrameRequestCallback) => {
			rafId += 1;
			pending = cb;
			return rafId;
		});
	const cancelSpy = vi
		.spyOn(globalThis, "cancelAnimationFrame")
		.mockImplementation((id: number) => {
			cancelled.push(id);
			if (pending !== null) pending = null;
		});

	const trigger = () => {
		if (observerCb) observerCb([]);
	};
	const flushRaf = () => {
		if (pending) {
			const cb = pending;
			pending = null;
			cb(performance.now());
		}
	};

	return {
		observed,
		disconnected,
		cancelled,
		trigger,
		flushRaf,
		restore() {
			globalThis.ResizeObserver = OriginalRO;
			rafSpy.mockRestore();
			cancelSpy.mockRestore();
		},
	};
}

function withClient(el: HTMLElement, w: number, h: number) {
	Object.defineProperty(el, "clientWidth", { configurable: true, value: w });
	Object.defineProperty(el, "clientHeight", { configurable: true, value: h });
}

function Probe({
	logicalW,
	logicalH,
	clientW,
	clientH,
	onScale,
}: {
	logicalW: number;
	logicalH: number;
	clientW: number;
	clientH: number;
	onScale: (n: number) => void;
}) {
	const { ref, scale } = useFitScale<HTMLDivElement>(logicalW, logicalH);
	useEffect(() => {
		onScale(scale);
	}, [scale, onScale]);
	return (
		<div
			ref={(el) => {
				if (el) {
					withClient(el, clientW, clientH);
					ref.current = el;
				}
			}}
		/>
	);
}

describe("useFitScale", () => {
	let env: ReturnType<typeof installControllableEnv>;
	beforeEach(() => {
		env = installControllableEnv();
	});
	afterEach(() => {
		env.restore();
	});

	it("初回 useLayoutEffect で client サイズから scale を計算する (幅律速)", () => {
		const scales: number[] = [];
		render(
			<Probe
				logicalW={1280}
				logicalH={720}
				clientW={640}
				clientH={720}
				onScale={(s) => scales.push(s)}
			/>,
		);
		// 640/1280 = 0.5, 720/720 = 1 → min = 0.5
		expect(scales.at(-1)).toBe(0.5);
	});

	it("高さ律速でも min を返す", () => {
		const scales: number[] = [];
		render(
			<Probe
				logicalW={1280}
				logicalH={720}
				clientW={1280}
				clientH={360}
				onScale={(s) => scales.push(s)}
			/>,
		);
		// 1280/1280 = 1, 360/720 = 0.5 → 0.5
		expect(scales.at(-1)).toBe(0.5);
	});

	it("clientWidth/Height が 0 なら scale を更新しない (初期値 1 のまま)", () => {
		const scales: number[] = [];
		render(
			<Probe
				logicalW={1280}
				logicalH={720}
				clientW={0}
				clientH={0}
				onScale={(s) => scales.push(s)}
			/>,
		);
		expect(scales.at(-1)).toBe(1);
	});

	it("要素を observe し、unmount で disconnect + 保留 rAF を cancel する", () => {
		const { unmount } = render(
			<Probe logicalW={1280} logicalH={720} clientW={640} clientH={480} onScale={() => {}} />,
		);
		expect(env.observed.length).toBe(1);
		act(() => env.trigger()); // observer notify → rAF 予約
		unmount();
		expect(env.disconnected.count).toBe(1);
		// unmount 時に保留 rAF が cancelAnimationFrame で回収される
		expect(env.cancelled.length).toBeGreaterThan(0);
	});

	it("同一フレーム内の連続通知は rAF で 1 回に coalesce し、flush で scale が再計算される", () => {
		let rafCalls = 0;
		const scales: number[] = [];
		let observedEl: HTMLElement | null = null;
		const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
		render(
			<Probe
				logicalW={1280}
				logicalH={720}
				clientW={1280}
				clientH={720}
				onScale={(s) => scales.push(s)}
			/>,
		);
		observedEl = env.observed[0] as HTMLElement;
		rafCalls = rafSpy.mock.calls.length;

		// 通知前は初回計算の scale=1
		expect(scales.at(-1)).toBe(1);

		// client サイズを縮めてから連続通知 → rAF は 1 回だけ追加、flush で scale 更新
		withClient(observedEl, 640, 720);
		act(() => {
			env.trigger();
			env.trigger();
			env.trigger();
		});
		expect(rafSpy.mock.calls.length - rafCalls).toBe(1);
		act(() => env.flushRaf());
		expect(scales.at(-1)).toBe(0.5);

		rafSpy.mockRestore();
	});
});
