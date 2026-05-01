import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { installDefaultApiMock } from "./__test-utils__/api-mock";

afterEach(() => {
	cleanup();
	// fake timers が次のテストに漏れて userEvent などが hung するのを防ぐため、
	// 各テスト終了時に必ず real timers に戻す。fake timers を使うテストは自身の
	// beforeEach で改めて vi.useFakeTimers() を呼ぶ。
	vi.useRealTimers();
});

beforeEach(() => {
	installDefaultApiMock();
});

if (!Range.prototype.getClientRects) {
	Range.prototype.getClientRects = () => ({
		length: 0,
		item: () => null,
		[Symbol.iterator]: [][Symbol.iterator],
	});
}
if (!Range.prototype.getBoundingClientRect) {
	Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

Object.defineProperty(window, "matchMedia", {
	writable: true,
	value: (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	}),
});
