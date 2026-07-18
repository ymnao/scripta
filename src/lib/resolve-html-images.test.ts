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

	it("deduplicates identical osPath: single read for N references", async () => {
		readFileBase64.mockClear();
		readFileBase64.mockResolvedValue("DUP");
		const out = await embedHtmlImagesAsDataUri(
			'<img src="./same.png"><img src="./same.png"><img src="./same.png">',
			"/workspace/deck.md",
		);
		// 3 img 参照でも readFileBase64 は 1 回だけ
		expect(readFileBase64).toHaveBeenCalledTimes(1);
		// 3 箇所全てに data URI が反映される
		const matches = out.match(/data:image\/png;base64,DUP/g);
		expect(matches?.length).toBe(3);
	});

	it("skips remaining images once total embedded bytes exceed the cap (#354)", async () => {
		readFileBase64.mockClear();
		// TOTAL_EMBED_BYTES_LIMIT = 256MB。3 個の 100MB base64 を投げれば 3 個目で超過する想定
		const CHUNK = "x".repeat(100 * 1024 * 1024);
		readFileBase64
			.mockResolvedValueOnce(CHUNK)
			.mockResolvedValueOnce(CHUNK)
			.mockResolvedValueOnce(CHUNK);
		const out = await embedHtmlImagesAsDataUri(
			'<img src="./a.png"><img src="./b.png"><img src="./c.png">',
			"/workspace/deck.md",
		);
		// 1〜2 個目は data URI 化される (累積 200MB < 256MB) → data URI が 2 箇所出現
		expect(out.split("data:image/png;base64,").length - 1).toBe(2);
		// 3 個目は上限超過で元 src を維持
		expect(out.includes('src="./c.png"')).toBe(true);
	});

	it("keeps original src when a single image would push over the total cap (#354)", async () => {
		readFileBase64.mockClear();
		// 1 個目で 200MB を使い、2 個目 (100MB) で累積 300MB > 256MB になり skip
		readFileBase64
			.mockResolvedValueOnce("y".repeat(200 * 1024 * 1024))
			.mockResolvedValueOnce("z".repeat(100 * 1024 * 1024));
		const out = await embedHtmlImagesAsDataUri(
			'<img src="./big.png"><img src="./over.png">',
			"/workspace/deck.md",
		);
		expect(out.split("data:image/png;base64,").length - 1).toBe(1);
		expect(out.includes('src="./over.png"')).toBe(true);
	});

	it("caps in-flight readFileBase64 to EMBED_CONCURRENCY (bounded concurrency)", async () => {
		readFileBase64.mockClear();
		let inFlight = 0;
		let peak = 0;
		readFileBase64.mockImplementation(async () => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return "X";
		});
		const html = Array.from({ length: 20 }, (_, i) => `<img src="./a${i}.png">`).join("");
		await embedHtmlImagesAsDataUri(html, "/workspace/deck.md");
		expect(readFileBase64).toHaveBeenCalledTimes(20);
		// EMBED_CONCURRENCY = 4。上限を超えた並列度が観測されないことを検証
		expect(peak).toBeLessThanOrEqual(4);
	});
});
