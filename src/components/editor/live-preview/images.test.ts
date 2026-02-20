import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { parentDir, resolveImageSrc } from "./images";

vi.mock("@tauri-apps/api/core", () => ({
	convertFileSrc: (path: string) => `asset://localhost${path}`,
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

	it("converts Unix absolute path via convertFileSrc", () => {
		const result = resolveImageSrc("/home/user/img.png", null);
		expect(result).toContain("asset://localhost/");
	});

	it("converts Windows absolute path (backslash) via convertFileSrc", () => {
		const result = resolveImageSrc("C:\\Users\\img.png", null);
		expect(result).toBe("asset://localhostC:\\Users\\img.png");
	});

	it("converts Windows absolute path (forward slash) via convertFileSrc", () => {
		const result = resolveImageSrc("C:/Users/img.png", null);
		expect(result).toBe("asset://localhostC:/Users/img.png");
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
		expect(result).toContain("C:\\Users\\docs\\image.png");
	});

	it("normalizes ./ prefix in relative path", () => {
		const result = resolveImageSrc("./image.png", "/home/user/docs/note.md");
		expect(result).toContain("/home/user/docs/image.png");
		expect(result).not.toContain("./");
	});

	it("normalizes .\\ prefix in relative path", () => {
		const result = resolveImageSrc(".\\image.png", "C:\\Users\\docs\\note.md");
		expect(result).toContain("C:\\Users\\docs\\image.png");
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
