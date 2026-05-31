import { describe, expect, it, vi } from "vitest";
import { buildScriptaAssetUrl } from "../../../../electron/preload/scripta-asset-url";
import { parentDir, resolveImageSrc } from "./images";

vi.mock("../../../lib/commands", () => ({
	// production と同一ロジックでモックする。preload の `buildAssetUrl` も同じ helper を
	// 呼んでおり、ここで挙動を分岐させる理由はない（mock がドリフトしてバグを隠す事故防止）。
	buildAssetUrl: (path: string) => buildScriptaAssetUrl(path),
}));

vi.mock("../../../stores/workspace", () => ({
	useWorkspaceStore: {
		getState: () => ({ activeTabPath: null }),
	},
}));

describe("parentDir", () => {
	it("extracts parent from Unix path", () => {
		expect(parentDir("/home/user/docs/note.md")).toBe("/home/user/docs");
	});

	it("extracts parent from Windows path", () => {
		expect(parentDir("C:\\Users\\user\\docs\\note.md")).toBe("C:\\Users\\user\\docs");
	});

	it("extracts parent from Windows path with forward slashes", () => {
		expect(parentDir("C:/Users/user/docs/note.md")).toBe("C:/Users/user/docs");
	});

	it("handles root Unix path", () => {
		expect(parentDir("/file.md")).toBe("/");
	});

	it("handles root Windows path", () => {
		expect(parentDir("C:\\file.md")).toBe("C:");
	});

	it("returns empty string for filename without separators", () => {
		expect(parentDir("file.md")).toBe("");
	});

	it("handles mixed separators (prefers last separator)", () => {
		expect(parentDir("C:\\Users/docs\\note.md")).toBe("C:\\Users/docs");
	});

	it("handles trailing separator", () => {
		expect(parentDir("/home/user/")).toBe("/home/user");
	});
});

describe("resolveImageSrc", () => {
	it("returns http URLs as-is", () => {
		expect(resolveImageSrc("http://example.com/img.png", null)).toBe("http://example.com/img.png");
	});

	it("returns https URLs as-is", () => {
		expect(resolveImageSrc("https://example.com/img.png", null)).toBe(
			"https://example.com/img.png",
		);
	});

	it("converts Unix absolute path via buildAssetUrl", () => {
		const result = resolveImageSrc("/home/user/img.png", null);
		expect(result).toBe("scripta-asset://localhost/home/user/img.png");
		// 旧実装は host が `localhostC` のような壊れた URL を生成していたため、
		// hostname round-trip で必ず "localhost" になることを検証する。
		expect(new URL(result).hostname).toBe("localhost");
	});

	it("converts Windows absolute path (backslash) via buildAssetUrl", () => {
		const result = resolveImageSrc("C:\\Users\\img.png", null);
		// 旧実装 `scripta-asset://localhostC:\\Users\\img.png` は new URL で Invalid URL。
		expect(new URL(result).hostname).toBe("localhost");
		expect(result).toBe("scripta-asset://localhost/C%3A/Users/img.png");
	});

	it("converts Windows absolute path (forward slash) via buildAssetUrl", () => {
		const result = resolveImageSrc("C:/Users/img.png", null);
		expect(new URL(result).hostname).toBe("localhost");
		expect(result).toBe("scripta-asset://localhost/C%3A/Users/img.png");
	});

	it("encodes # / ? so the URL is not split into pathname/hash/search", () => {
		const result = resolveImageSrc("/tmp/a#b?c.png", null);
		const parsed = new URL(result);
		expect(parsed.pathname).toBe("/tmp/a%23b%3Fc.png");
		expect(parsed.hash).toBe("");
		expect(parsed.search).toBe("");
	});

	it("returns raw URL when activeTabPath is null", () => {
		expect(resolveImageSrc("image.png", null)).toBe("image.png");
	});

	it("resolves relative path from Unix activeTabPath", () => {
		const result = resolveImageSrc("image.png", "/home/user/docs/note.md");
		expect(result).toContain("/home/user/docs/image.png");
	});

	it("resolves relative path from Windows activeTabPath", () => {
		const result = resolveImageSrc("image.png", "C:\\Users\\docs\\note.md");
		// `\` は URL pathname で `/` に正規化、`:` は per-segment encodeURIComponent で `%3A`
		expect(result).toContain("C%3A/Users/docs/image.png");
	});

	it("normalizes ./ prefix in relative path", () => {
		const result = resolveImageSrc("./image.png", "/home/user/docs/note.md");
		expect(result).toContain("/home/user/docs/image.png");
		expect(result).not.toContain("./");
	});

	it("normalizes .\\ prefix in relative path", () => {
		const result = resolveImageSrc(".\\image.png", "C:\\Users\\docs\\note.md");
		expect(result).toContain("C%3A/Users/docs/image.png");
		expect(result).not.toContain(".\\");
	});

	it("resolves relative path from Unix root without double separator", () => {
		const result = resolveImageSrc("image.png", "/note.md");
		expect(result).toContain("/image.png");
		expect(result).not.toContain("//image.png");
	});

	it("returns raw URL when parentDir is empty (bare filename tab)", () => {
		expect(resolveImageSrc("image.png", "note.md")).toBe("image.png");
	});
});
