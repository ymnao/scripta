import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { installDefaultApiMock } from "./__test-utils__/api-mock";

// Node.js 26+ + vitest 4 + jsdom 29 の組み合わせで、Node の experimental
// localStorage global が jsdom の window.localStorage getter を shadow し、
// `--localstorage-file` 未指定だと typeof window.localStorage === "undefined"
// になる。CI は Node 22.13 を使うので発生しないが、ローカルで Node 26+ で
// `pnpm verify` を回せるよう、jsdom 内部の _localStorage / _sessionStorage を
// value として直接焼き付けて getter chain を回避する。
const jsdomWindow = window as unknown as {
	_localStorage?: Storage;
	_sessionStorage?: Storage;
};
if (jsdomWindow._localStorage && typeof globalThis.localStorage === "undefined") {
	Object.defineProperty(globalThis, "localStorage", {
		value: jsdomWindow._localStorage,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(window, "localStorage", {
		value: jsdomWindow._localStorage,
		configurable: true,
		writable: true,
	});
}
if (jsdomWindow._sessionStorage && typeof globalThis.sessionStorage === "undefined") {
	Object.defineProperty(globalThis, "sessionStorage", {
		value: jsdomWindow._sessionStorage,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(window, "sessionStorage", {
		value: jsdomWindow._sessionStorage,
		configurable: true,
		writable: true,
	});
}

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
	configurable: true,
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
