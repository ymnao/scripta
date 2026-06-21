// @vitest-environment node
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// shell.openExternal は実際にブラウザを起動し得るため必ず stub。
vi.mock("electron", () => ({
	shell: { openExternal: vi.fn(async () => {}) },
}));

import { attachNavigationGuards } from "./window-guards";

// 最小の fake WebContents。setWindowOpenHandler と "will-navigate" listener を
// 捕捉し、テストから直接呼び出して deny / preventDefault の挙動を verify する。
function makeFakeWebContents() {
	let windowOpenHandler: ((details: { url: string }) => { action: "deny" | "allow" }) | null = null;
	let willNavigateHandler: ((event: { preventDefault: () => void }, url: string) => void) | null =
		null;
	const wc = {
		setWindowOpenHandler: vi.fn((h: typeof windowOpenHandler) => {
			windowOpenHandler = h;
		}),
		on: vi.fn((event: string, h: NonNullable<typeof willNavigateHandler>) => {
			if (event === "will-navigate") willNavigateHandler = h;
		}),
	} as unknown as WebContents;
	return {
		wc,
		callWindowOpen: (url: string) => {
			if (windowOpenHandler === null) throw new Error("windowOpenHandler not installed");
			return windowOpenHandler({ url });
		},
		callWillNavigate: (url: string): { preventDefault: ReturnType<typeof vi.fn> } => {
			if (willNavigateHandler === null) throw new Error("will-navigate listener not installed");
			const event = { preventDefault: vi.fn() };
			willNavigateHandler(event, url);
			return event;
		},
	};
}

describe("attachNavigationGuards", () => {
	const original = process.env.ELECTRON_RENDERER_URL;

	beforeEach(() => {
		process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
	});

	afterEach(() => {
		if (original === undefined) {
			delete process.env.ELECTRON_RENDERER_URL;
		} else {
			process.env.ELECTRON_RENDERER_URL = original;
		}
	});

	it("installs setWindowOpenHandler and will-navigate listener exactly once", () => {
		const { wc } = makeFakeWebContents();
		attachNavigationGuards(wc);
		expect(wc.setWindowOpenHandler).toHaveBeenCalledTimes(1);
		expect(wc.on).toHaveBeenCalledWith("will-navigate", expect.any(Function));
	});

	it("setWindowOpenHandler always returns deny (no in-app new window)", () => {
		const { wc, callWindowOpen } = makeFakeWebContents();
		attachNavigationGuards(wc);
		expect(callWindowOpen("https://example.com").action).toBe("deny");
		expect(callWindowOpen("http://localhost:5173/").action).toBe("deny");
		expect(callWindowOpen("file:///tmp/evil.html").action).toBe("deny");
	});

	it("will-navigate allows URLs inside the renderer dir (no preventDefault)", () => {
		const { wc, callWillNavigate } = makeFakeWebContents();
		attachNavigationGuards(wc);
		const event = callWillNavigate("http://localhost:5173/index.html");
		expect(event.preventDefault).not.toHaveBeenCalled();
	});

	it("will-navigate blocks renderer-dir 外 navigation (本 PR の主要ガード)", () => {
		const { wc, callWillNavigate } = makeFakeWebContents();
		attachNavigationGuards(wc);
		// レビュー再現: 任意 local HTML への遷移を遮断
		const event1 = callWillNavigate("file:///tmp/evil.html");
		expect(event1.preventDefault).toHaveBeenCalled();
		// 別 origin の web URL も遮断
		const event2 = callWillNavigate("http://evil.example.com/");
		expect(event2.preventDefault).toHaveBeenCalled();
	});
});
