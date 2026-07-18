import { describe, expect, it, vi } from "vitest";
import { buildScriptaAssetUrl } from "../../electron/preload/scripta-asset-url";
import { embedHtmlImagesAsDataUri, resolveHtmlImageSrcs } from "./resolve-html-images";

const readFileBase64 = vi.fn(async (_path: string) => "AAAA");

vi.mock("./commands", () => ({
	buildAssetUrl: (path: string) => buildScriptaAssetUrl(path),
	readFileBase64: (path: string) => readFileBase64(path),
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

describe("embedHtmlImagesAsDataUri", () => {
	it("returns identical html when no img tag present (fast path)", async () => {
		const html = "<p>plain text</p>";
		expect(await embedHtmlImagesAsDataUri(html, "/workspace/deck.md")).toBe(html);
	});

	it("replaces relative img src with data URI", async () => {
		readFileBase64.mockResolvedValueOnce("BASE64PNG");
		const out = await embedHtmlImagesAsDataUri(
			'<img src="./img/hero.png">',
			"/workspace/notes/deck.md",
		);
		expect(readFileBase64).toHaveBeenCalledWith("/workspace/notes/img/hero.png");
		expect(out).toContain('src="data:image/png;base64,BASE64PNG"');
	});

	it("replaces absolute workspace path with data URI (svg mime)", async () => {
		readFileBase64.mockResolvedValueOnce("SVGDATA");
		const out = await embedHtmlImagesAsDataUri(
			'<img src="/workspace/logo.svg">',
			"/workspace/notes/deck.md",
		);
		expect(readFileBase64).toHaveBeenCalledWith("/workspace/logo.svg");
		expect(out).toContain('src="data:image/svg+xml;base64,SVGDATA"');
	});

	it("leaves http(s) src untouched without calling readFileBase64", async () => {
		readFileBase64.mockClear();
		const out = await embedHtmlImagesAsDataUri(
			'<img src="https://example.com/x.png">',
			"/workspace/deck.md",
		);
		expect(readFileBase64).not.toHaveBeenCalled();
		expect(out).toContain('src="https://example.com/x.png"');
	});

	it("leaves data: src untouched", async () => {
		readFileBase64.mockClear();
		const out = await embedHtmlImagesAsDataUri(
			'<img src="data:image/png;base64,AAAA">',
			"/workspace/deck.md",
		);
		expect(readFileBase64).not.toHaveBeenCalled();
		expect(out).toContain('src="data:image/png;base64,AAAA"');
	});

	it("skips unsupported extensions (mp4 as img is nonsensical, leave untouched)", async () => {
		readFileBase64.mockClear();
		const out = await embedHtmlImagesAsDataUri('<img src="./video.mp4">', "/workspace/deck.md");
		expect(readFileBase64).not.toHaveBeenCalled();
		expect(out).toContain('src="./video.mp4"');
	});

	it("keeps original src on readFileBase64 failure", async () => {
		readFileBase64.mockRejectedValueOnce(new Error("EACCES"));
		const out = await embedHtmlImagesAsDataUri('<img src="./missing.png">', "/workspace/deck.md");
		expect(out).toContain('src="./missing.png"');
		expect(out).not.toContain("data:image/png");
	});

	it("handles multiple images (Promise.all parallel path)", async () => {
		readFileBase64
			.mockResolvedValueOnce("AAA")
			.mockResolvedValueOnce("BBB")
			.mockResolvedValueOnce("CCC");
		const out = await embedHtmlImagesAsDataUri(
			'<img src="./a.png"><img src="./b.jpg"><img src="./c.gif">',
			"/workspace/deck.md",
		);
		expect(out).toContain("data:image/png;base64,AAA");
		expect(out).toContain("data:image/jpeg;base64,BBB");
		expect(out).toContain("data:image/gif;base64,CCC");
	});

	it("mixes success and failure per image (partial fallback)", async () => {
		readFileBase64.mockResolvedValueOnce("OK").mockRejectedValueOnce(new Error("ENOENT"));
		const out = await embedHtmlImagesAsDataUri(
			'<img src="./ok.png"><img src="./bad.png">',
			"/workspace/deck.md",
		);
		expect(out).toContain("data:image/png;base64,OK");
		expect(out).toContain('src="./bad.png"');
	});

	it("case-insensitive extension matching (PNG, JPEG)", async () => {
		readFileBase64.mockResolvedValueOnce("UP1").mockResolvedValueOnce("UP2");
		const out = await embedHtmlImagesAsDataUri(
			'<img src="./A.PNG"><img src="./B.JPEG">',
			"/workspace/deck.md",
		);
		expect(out).toContain("data:image/png;base64,UP1");
		expect(out).toContain("data:image/jpeg;base64,UP2");
	});
});
