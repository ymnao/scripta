import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCollapseToggle } from "./useCollapseToggle";

describe("useCollapseToggle", () => {
	it("初期状態ではすべての key が折り畳まれていない", () => {
		const { result } = renderHook(() => useCollapseToggle());
		expect(result.current.isCollapsed("a")).toBe(false);
		expect(result.current.isCollapsed("b")).toBe(false);
	});

	it("toggle で同じ key を交互に開閉できる", () => {
		const { result } = renderHook(() => useCollapseToggle());
		act(() => result.current.toggle("a"));
		expect(result.current.isCollapsed("a")).toBe(true);
		act(() => result.current.toggle("a"));
		expect(result.current.isCollapsed("a")).toBe(false);
	});

	it("複数 key の collapsed 状態は独立する", () => {
		const { result } = renderHook(() => useCollapseToggle());
		act(() => result.current.toggle("a"));
		act(() => result.current.toggle("b"));
		expect(result.current.isCollapsed("a")).toBe(true);
		expect(result.current.isCollapsed("b")).toBe(true);
		act(() => result.current.toggle("a"));
		expect(result.current.isCollapsed("a")).toBe(false);
		expect(result.current.isCollapsed("b")).toBe(true);
	});

	it("reset で全 key の collapsed 状態が初期化される", () => {
		const { result } = renderHook(() => useCollapseToggle());
		act(() => result.current.toggle("a"));
		act(() => result.current.toggle("b"));
		act(() => result.current.reset());
		expect(result.current.isCollapsed("a")).toBe(false);
		expect(result.current.isCollapsed("b")).toBe(false);
	});

	it("reset 後の toggle が新規 collapsed として再開される", () => {
		const { result } = renderHook(() => useCollapseToggle());
		act(() => result.current.toggle("a"));
		act(() => result.current.reset());
		act(() => result.current.toggle("a"));
		expect(result.current.isCollapsed("a")).toBe(true);
	});

	it("toggle と reset は再 render を跨いで stable な reference", () => {
		const { result, rerender } = renderHook(() => useCollapseToggle());
		const toggle1 = result.current.toggle;
		const reset1 = result.current.reset;
		act(() => result.current.toggle("a"));
		rerender();
		expect(result.current.toggle).toBe(toggle1);
		expect(result.current.reset).toBe(reset1);
	});
});
