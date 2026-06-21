// @vitest-environment node
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAllowedRendererUrl } from "./renderer-url";

// 本ファイルから見て `../renderer` が prod モードでの RENDERER_FILE_DIR と一致する。
// renderer-url.ts と同 dir に置いてあるので __dirname は同じ。
const RENDERER_FILE_DIR = join(__dirname, "../renderer");

describe("isAllowedRendererUrl", () => {
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

		it("accepts the configured origin and any pathname under it", () => {
			expect(isAllowedRendererUrl("http://localhost:5173")).toBe(true);
			expect(isAllowedRendererUrl("http://localhost:5173/")).toBe(true);
			expect(isAllowedRendererUrl("http://localhost:5173/index.html")).toBe(true);
			expect(isAllowedRendererUrl("http://localhost:5173/?conflict=true")).toBe(true);
		});

		it("rejects a different port / host / scheme", () => {
			expect(isAllowedRendererUrl("http://localhost:6173/")).toBe(false);
			expect(isAllowedRendererUrl("http://evil.example.com/")).toBe(false);
			expect(isAllowedRendererUrl("https://localhost:5173/")).toBe(false);
		});

		it("rejects file: URLs in dev mode (path-based prod check does not apply)", () => {
			expect(isAllowedRendererUrl("file:///tmp/evil.html")).toBe(false);
			expect(isAllowedRendererUrl("file://")).toBe(false);
		});

		it("rejects malformed input", () => {
			expect(isAllowedRendererUrl("not-a-url")).toBe(false);
			expect(isAllowedRendererUrl("")).toBe(false);
		});
	});

	describe("prod mode (no ELECTRON_RENDERER_URL)", () => {
		it("accepts file: URLs inside the renderer dir (pathname check)", () => {
			expect(
				isAllowedRendererUrl(pathToFileURL(join(RENDERER_FILE_DIR, "index.html")).toString()),
			).toBe(true);
			expect(
				isAllowedRendererUrl(pathToFileURL(join(RENDERER_FILE_DIR, "assets/app.js")).toString()),
			).toBe(true);
		});

		it("rejects file: URLs outside the renderer dir (this is the actual regression)", () => {
			// レビュー指摘の本旨: 任意の local HTML が「信頼 renderer」と判定されない事を保証する
			expect(isAllowedRendererUrl(pathToFileURL("/tmp/evil.html").toString())).toBe(false);
			expect(isAllowedRendererUrl(pathToFileURL("/etc/passwd").toString())).toBe(false);
		});

		it("rejects file: scheme alone (no path)", () => {
			expect(isAllowedRendererUrl("file://")).toBe(false);
		});

		it("rejects http(s) origins", () => {
			expect(isAllowedRendererUrl("http://localhost:5173/")).toBe(false);
			expect(isAllowedRendererUrl("https://evil.example.com/")).toBe(false);
		});

		it("rejects malformed input", () => {
			expect(isAllowedRendererUrl("not-a-url")).toBe(false);
			expect(isAllowedRendererUrl("")).toBe(false);
		});
	});
});
