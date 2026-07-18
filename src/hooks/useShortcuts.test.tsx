import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { type Shortcut, type UseShortcutsOptions, useShortcuts } from "./useShortcuts";

function Harness({
	shortcuts,
	options,
}: {
	shortcuts: Shortcut[];
	options?: UseShortcutsOptions;
}): ReactElement {
	useShortcuts(shortcuts, options);
	return <div data-testid="harness" />;
}

function dispatchKey(init: KeyboardEventInit): void {
	document.dispatchEvent(new KeyboardEvent("keydown", init));
}

describe("useShortcuts", () => {
	it("マッチした最初のエントリの run のみを呼ぶ (first match wins)", () => {
		const runA = vi.fn();
		const runB = vi.fn();
		render(
			<Harness
				shortcuts={[
					{ id: "a", match: (e) => e.key === "a", run: runA },
					{ id: "a-dup", match: (e) => e.key === "a", run: runB },
				]}
			/>,
		);
		dispatchKey({ key: "a" });
		expect(runA).toHaveBeenCalledTimes(1);
		expect(runB).not.toHaveBeenCalled();
	});

	it("どのエントリにもマッチしなければ何も呼ばれない", () => {
		const run = vi.fn();
		render(<Harness shortcuts={[{ id: "a", match: (e) => e.key === "a", run }]} />);
		dispatchKey({ key: "b" });
		expect(run).not.toHaveBeenCalled();
	});

	it("modifier 判定を match に委ねる (meta+shift+key など)", () => {
		const run = vi.fn();
		render(
			<Harness
				shortcuts={[
					{
						id: "cmd-shift-p",
						match: (e) => (e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "P",
						run,
					},
				]}
			/>,
		);
		dispatchKey({ key: "P", metaKey: true, shiftKey: true });
		expect(run).toHaveBeenCalledTimes(1);
		dispatchKey({ key: "P", shiftKey: true }); // meta なし → 不発
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("再レンダーで shortcuts 配列を差し替えても最新版が使われる (ref 更新)", () => {
		const runOld = vi.fn();
		const runNew = vi.fn();
		const { rerender } = render(
			<Harness shortcuts={[{ id: "x", match: (e) => e.key === "x", run: runOld }]} />,
		);
		dispatchKey({ key: "x" });
		expect(runOld).toHaveBeenCalledTimes(1);

		rerender(<Harness shortcuts={[{ id: "x", match: (e) => e.key === "x", run: runNew }]} />);
		dispatchKey({ key: "x" });
		expect(runOld).toHaveBeenCalledTimes(1); // 増えない
		expect(runNew).toHaveBeenCalledTimes(1);
	});

	it("unmount で listener が解除される", () => {
		const run = vi.fn();
		const { unmount } = render(
			<Harness shortcuts={[{ id: "a", match: (e) => e.key === "a", run }]} />,
		);
		dispatchKey({ key: "a" });
		expect(run).toHaveBeenCalledTimes(1);
		unmount();
		dispatchKey({ key: "a" });
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("空の shortcuts 配列でもエラーなく動く", () => {
		render(<Harness shortcuts={[]} />);
		expect(() => dispatchKey({ key: "a" })).not.toThrow();
	});

	it("match=true の時 preventDefault を自動で呼ぶ (default)", () => {
		const run = vi.fn();
		render(<Harness shortcuts={[{ id: "a", match: (e) => e.key === "a", run }]} />);
		const ev = new KeyboardEvent("keydown", { key: "a", cancelable: true });
		const spy = vi.spyOn(ev, "preventDefault");
		document.dispatchEvent(ev);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("preventDefault: false を明示すれば自動 preventDefault はスキップ", () => {
		const run = vi.fn();
		render(
			<Harness
				shortcuts={[{ id: "a", match: (e) => e.key === "a", run, preventDefault: false }]}
			/>,
		);
		const ev = new KeyboardEvent("keydown", { key: "a", cancelable: true });
		const spy = vi.spyOn(ev, "preventDefault");
		document.dispatchEvent(ev);
		expect(spy).not.toHaveBeenCalled();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("match=false の時は preventDefault も run も呼ばれない", () => {
		const run = vi.fn();
		render(<Harness shortcuts={[{ id: "a", match: (e) => e.key === "a", run }]} />);
		const ev = new KeyboardEvent("keydown", { key: "b", cancelable: true });
		const spy = vi.spyOn(ev, "preventDefault");
		document.dispatchEvent(ev);
		expect(spy).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it("options.stopPropagation: true → match 時に e.stopPropagation() が呼ばれる", () => {
		const run = vi.fn();
		render(
			<Harness
				shortcuts={[{ id: "a", match: (e) => e.key === "a", run }]}
				options={{ stopPropagation: true }}
			/>,
		);
		const ev = new KeyboardEvent("keydown", { key: "a", cancelable: true });
		const spy = vi.spyOn(ev, "stopPropagation");
		document.dispatchEvent(ev);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("options.stopPropagation を省略すると e.stopPropagation() は呼ばれない (default false)", () => {
		const run = vi.fn();
		render(<Harness shortcuts={[{ id: "a", match: (e) => e.key === "a", run }]} />);
		const ev = new KeyboardEvent("keydown", { key: "a", cancelable: true });
		const spy = vi.spyOn(ev, "stopPropagation");
		document.dispatchEvent(ev);
		expect(spy).not.toHaveBeenCalled();
	});

	it("capture: true + stopPropagation: true → match 時に bubble listener に届かない", () => {
		const bubbleSeen = vi.fn();
		const bubbleListener = () => bubbleSeen();
		document.addEventListener("keydown", bubbleListener);
		try {
			const run = vi.fn();
			render(
				<Harness
					shortcuts={[{ id: "a", match: (e) => e.key === "a", run }]}
					options={{ capture: true, stopPropagation: true }}
				/>,
			);
			const target = document.createElement("span");
			document.body.appendChild(target);
			try {
				target.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
			} finally {
				document.body.removeChild(target);
			}
			expect(run).toHaveBeenCalledTimes(1);
			expect(bubbleSeen).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener("keydown", bubbleListener);
		}
	});

	it("stopPropagation: true でもマッチしないキーは伝播を止めない", () => {
		const run = vi.fn();
		render(
			<Harness
				shortcuts={[{ id: "a", match: (e) => e.key === "a", run }]}
				options={{ stopPropagation: true }}
			/>,
		);
		const ev = new KeyboardEvent("keydown", { key: "b", cancelable: true });
		const spy = vi.spyOn(ev, "stopPropagation");
		document.dispatchEvent(ev);
		expect(run).not.toHaveBeenCalled();
		expect(spy).not.toHaveBeenCalled();
	});

	it("rerender で capture / stopPropagation が変わっても listener 重複しない", () => {
		const run = vi.fn();
		const shortcuts: Shortcut[] = [{ id: "a", match: (e) => e.key === "a", run }];
		const { rerender, unmount } = render(
			<Harness shortcuts={shortcuts} options={{ capture: false, stopPropagation: false }} />,
		);
		dispatchKey({ key: "a" });
		expect(run).toHaveBeenCalledTimes(1);
		rerender(<Harness shortcuts={shortcuts} options={{ capture: true, stopPropagation: true }} />);
		dispatchKey({ key: "a" });
		// 旧 listener が解除されていれば新 listener 1 回だけで累計 2 回。
		expect(run).toHaveBeenCalledTimes(2);
		rerender(
			<Harness shortcuts={shortcuts} options={{ capture: false, stopPropagation: false }} />,
		);
		dispatchKey({ key: "a" });
		expect(run).toHaveBeenCalledTimes(3);
		unmount();
		dispatchKey({ key: "a" });
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("capture: true → capture フェーズで attach され、bubble listener より先に発火する", () => {
		const bubbleSeen = vi.fn();
		const captureSeen = vi.fn();
		const order: string[] = [];
		const bubbleListener = () => {
			bubbleSeen();
			order.push("bubble");
		};
		document.addEventListener("keydown", bubbleListener);
		try {
			render(
				<Harness
					shortcuts={[
						{
							id: "a",
							match: (e) => e.key === "a",
							run: () => {
								captureSeen();
								order.push("capture");
							},
							// stopPropagation しないので bubble も見る。
						},
					]}
					options={{ capture: true }}
				/>,
			);
			// document 内の bubble ターゲットに向けて dispatch する。
			const target = document.createElement("span");
			document.body.appendChild(target);
			try {
				target.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
			} finally {
				document.body.removeChild(target);
			}
			expect(captureSeen).toHaveBeenCalledTimes(1);
			expect(bubbleSeen).toHaveBeenCalledTimes(1);
			expect(order).toEqual(["capture", "bubble"]);
		} finally {
			document.removeEventListener("keydown", bubbleListener);
		}
	});
});
