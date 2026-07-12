import { describe, expect, it, vi } from "vitest";
import { buildScriptaAssetUrl } from "../../electron/preload/scripta-asset-url";
import { resolveHtmlImageSrcs } from "./resolve-html-images";

vi.mock("./commands", () => ({
	buildAssetUrl: (path: string) => buildScriptaAssetUrl(path),
}));

vi.mock("../stores/workspace", () => ({
	useWorkspaceStore: {
		getState: () => ({ activeTabPath: null }),
	},
}));

describe("resolveHtmlImageSrcs", () => {
	it("rewrites relative img src to scripta-asset URL", () => {
		const out = resolveHtmlImageSrcs(
			'<p><img src="./img/hero.png" alt="a"></p>',
			"/workspace/notes/deck.md",
		);
		expect(out).toContain('src="scripta-asset://localhost/workspace/notes/img/hero.png"');
	});

	it("rewrites absolute img src to scripta-asset URL", () => {
		const out = resolveHtmlImageSrcs(
			'<img src="/workspace/logo.svg" alt="l">',
			"/workspace/notes/deck.md",
		);
		expect(out).toContain('src="scripta-asset://localhost/workspace/logo.svg"');
	});

	it("leaves http(s) URLs untouched", () => {
		const html = '<img src="https://example.com/x.png" alt="x">';
		const out = resolveHtmlImageSrcs(html, "/workspace/deck.md");
		expect(out).toContain('src="https://example.com/x.png"');
	});

	it("returns identical html when no img tag present (fast path)", () => {
		const html = "<p>plain text</p>";
		expect(resolveHtmlImageSrcs(html, "/workspace/deck.md")).toBe(html);
	});

	it("preserves surrounding HTML structure (non-img content untouched)", () => {
		const out = resolveHtmlImageSrcs(
			'<h1>Title</h1><p>text</p><img src="./a.png"><p>more</p>',
			"/workspace/deck.md",
		);
		expect(out).toContain("<h1>Title</h1>");
		expect(out).toContain("<p>text</p>");
		expect(out).toContain("<p>more</p>");
		expect(out).toContain('src="scripta-asset://localhost/workspace/a.png"');
	});
});
