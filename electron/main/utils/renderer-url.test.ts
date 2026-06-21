// @vitest-environment node
import { join } from "node:path";
import * as posix from "node:path/posix";
import * as win32 from "node:path/win32";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAllowedRendererUrl, isFileUrlInsideDir, type PathOps } from "./renderer-url";

// 本ファイルから見て `../renderer` が prod モードでの RENDERER_FILE_DIR と一致する。
// renderer-url.ts と同 dir に置いてあるので __dirname は同じ。
const RENDERER_FILE_DIR = join(__dirname, "../renderer");

// host OS をまたいで Windows / POSIX の挙動を検証するため、`fileURLToPath` の windows
// オプションと `node:path/{posix,win32}` を差し替えた pathOps を用意する。production
// code は host OS の default ops を使うので、別 OS の挙動は本テストでだけ verify する。
const posixOps: PathOps = {
	fileURLToPath: (u: URL) => fileURLToPath(u, { windows: false }),
	relative: posix.relative,
	isAbsolute: posix.isAbsolute,
};
const win32Ops: PathOps = {
	fileURLToPath: (u: URL) => fileURLToPath(u, { windows: true }),
	relative: win32.relative,
	isAbsolute: win32.isAbsolute,
};

describe("isFileUrlInsideDir (cross-OS regression)", () => {
	describe("POSIX (macOS / Linux)", () => {
		const base = "/app/out/renderer";

		it("accepts URLs under base dir", () => {
			expect(isFileUrlInsideDir("file:///app/out/renderer/index.html", base, posixOps)).toBe(true);
			expect(isFileUrlInsideDir("file:///app/out/renderer/assets/app.js", base, posixOps)).toBe(
				true,
			);
		});

		it("accepts the base dir itself", () => {
			expect(isFileUrlInsideDir("file:///app/out/renderer", base, posixOps)).toBe(true);
		});

		it("rejects outside base dir", () => {
			expect(isFileUrlInsideDir("file:///tmp/evil.html", base, posixOps)).toBe(false);
			expect(isFileUrlInsideDir("file:///etc/passwd", base, posixOps)).toBe(false);
		});

		it("rejects a sibling dir with a prefix-colliding name", () => {
			expect(isFileUrlInsideDir("file:///app/out/renderer-evil/x.html", base, posixOps)).toBe(
				false,
			);
		});

		it("rejects URLs that escape via `..` segments", () => {
			// URL parser が `..` segment を normalize し、relative も `..` を含む形になる。
			expect(isFileUrlInsideDir("file:///app/out/renderer/../evil.html", base, posixOps)).toBe(
				false,
			);
		});
	});

	describe("Windows (本 P1 の本旨: macOS 上でも Windows 形式の URL 判定が動くこと)", () => {
		const base = "C:\\app\\out\\renderer";

		it("accepts a renderer URL on Windows (file:///C:/... → C:\\... へ正しく変換)", () => {
			// URL.pathname (`/C:/app/out/renderer/index.html`) を生で比較していた前回実装は
			// Windows base dir (`C:\\app\\out\\renderer`) と形式・区切り両方ズレて false に
			// なっていた。fileURLToPath + path.win32.relative で正規化されることを verify。
			expect(isFileUrlInsideDir("file:///C:/app/out/renderer/index.html", base, win32Ops)).toBe(
				true,
			);
			expect(isFileUrlInsideDir("file:///C:/app/out/renderer/assets/app.js", base, win32Ops)).toBe(
				true,
			);
		});

		it("accepts the base dir itself on Windows", () => {
			expect(isFileUrlInsideDir("file:///C:/app/out/renderer", base, win32Ops)).toBe(true);
		});

		it("rejects a sibling dir on the same drive", () => {
			expect(isFileUrlInsideDir("file:///C:/Users/Evil/Desktop/evil.html", base, win32Ops)).toBe(
				false,
			);
		});

		it("rejects another drive (D:)", () => {
			expect(isFileUrlInsideDir("file:///D:/payload.html", base, win32Ops)).toBe(false);
		});

		it("rejects UNC paths", () => {
			expect(isFileUrlInsideDir("file://server/share/evil.html", base, win32Ops)).toBe(false);
		});

		it("rejects URLs that escape via `..` segments on Windows", () => {
			expect(isFileUrlInsideDir("file:///C:/app/out/renderer/../evil.html", base, win32Ops)).toBe(
				false,
			);
		});
	});

	describe("common", () => {
		it("rejects non-file: schemes (both POSIX and Windows)", () => {
			expect(isFileUrlInsideDir("http://example.com/", "/app/out/renderer", posixOps)).toBe(false);
			expect(isFileUrlInsideDir("https://example.com/", "C:\\app\\out\\renderer", win32Ops)).toBe(
				false,
			);
		});

		it("rejects malformed input", () => {
			expect(isFileUrlInsideDir("not-a-url", "/app/out/renderer", posixOps)).toBe(false);
			expect(isFileUrlInsideDir("", "/app/out/renderer", posixOps)).toBe(false);
		});
	});
});

describe("isAllowedRendererUrl (uses host OS path ops)", () => {
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

	describe("prod mode (no ELECTRON_RENDERER_URL) — host OS behaviour", () => {
		it("accepts file: URLs inside the renderer dir on the host OS", () => {
			expect(
				isAllowedRendererUrl(pathToFileURL(join(RENDERER_FILE_DIR, "index.html")).toString()),
			).toBe(true);
			expect(
				isAllowedRendererUrl(pathToFileURL(join(RENDERER_FILE_DIR, "assets/app.js")).toString()),
			).toBe(true);
		});

		it("rejects file: URLs outside the renderer dir on the host OS", () => {
			expect(isAllowedRendererUrl(pathToFileURL("/tmp/evil.html").toString())).toBe(false);
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
