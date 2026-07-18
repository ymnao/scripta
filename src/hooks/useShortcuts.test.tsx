import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { type Shortcut, useShortcuts } from "./useShortcuts";

function Harness({ shortcuts }: { shortcuts: Shortcut[] }): ReactElement {
	useShortcuts(shortcuts);
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
});
