import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

afterEach(() => {
	cleanup();
});

// jsdom does not implement Range layout methods that CodeMirror relies on.
// Polyfill them to avoid noisy "getClientRects is not a function" errors.
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
