// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isTrustedRendererOrigin } from "./renderer-url";

describe("isTrustedRendererOrigin", () => {
	const original = process.env.ELECTRON_RENDERER_URL;

	beforeEach(() => {
		delete process.env.ELECTRON_RENDERER_URL;
	});

	afterEach(() => {
		if (original === undefined) {
			delete process.env.ELECTRON_RENDERER_URL;
		} else {
			process.env.ELECTRON_RENDERER_URL = original;
		}
	});

	describe("dev mode (ELECTRON_RENDERER_URL set)", () => {
		beforeEach(() => {
			process.env.ELECTRON_RENDERER_URL = "http://localhost:5173/";
		});

		it("accepts the configured origin", () => {
			expect(isTrustedRendererOrigin("http://localhost:5173")).toBe(true);
			expect(isTrustedRendererOrigin("http://localhost:5173/")).toBe(true);
			expect(isTrustedRendererOrigin("http://localhost:5173/index.html")).toBe(true);
		});

		it("rejects a different port", () => {
			expect(isTrustedRendererOrigin("http://localhost:6173")).toBe(false);
		});

		it("rejects a different host", () => {
			expect(isTrustedRendererOrigin("http://evil.example.com")).toBe(false);
		});

		it("rejects a different scheme", () => {
			expect(isTrustedRendererOrigin("https://localhost:5173")).toBe(false);
			expect(isTrustedRendererOrigin("file://")).toBe(false);
		});

		it("rejects malformed input", () => {
			expect(isTrustedRendererOrigin("not-a-url")).toBe(false);
			expect(isTrustedRendererOrigin("")).toBe(false);
		});
	});

	describe("prod mode (no ELECTRON_RENDERER_URL)", () => {
		it("accepts any file: origin / URL", () => {
			expect(isTrustedRendererOrigin("file://")).toBe(true);
			expect(isTrustedRendererOrigin("file:///Applications/scripta.app/...")).toBe(true);
		});

		it("rejects http(s) origins", () => {
			expect(isTrustedRendererOrigin("http://localhost:5173")).toBe(false);
			expect(isTrustedRendererOrigin("https://evil.example.com")).toBe(false);
		});

		it("rejects malformed input", () => {
			expect(isTrustedRendererOrigin("not-a-url")).toBe(false);
		});
	});
});
