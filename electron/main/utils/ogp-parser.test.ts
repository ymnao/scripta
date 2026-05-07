// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, parseOgp } from "./ogp-parser";

describe("decodeHtmlEntities", () => {
	it("decodes basic entities", () => {
		expect(decodeHtmlEntities("&lt;3&gt;")).toBe("<3>");
		expect(decodeHtmlEntities("&quot;hi&quot;")).toBe('"hi"');
		expect(decodeHtmlEntities("It&#39;s")).toBe("It's");
		expect(decodeHtmlEntities("&#x27;quoted&#x27;")).toBe("'quoted'");
		expect(decodeHtmlEntities("a&#x2F;b")).toBe("a/b");
	});
	it("decodes &amp; last (no double-decode)", () => {
		// &amp;lt; should become &lt; (NOT <)
		expect(decodeHtmlEntities("&amp;lt;")).toBe("&lt;");
		expect(decodeHtmlEntities("&amp;amp;")).toBe("&amp;");
	});
	it("does not modify text without entities", () => {
		expect(decodeHtmlEntities("plain text")).toBe("plain text");
		expect(decodeHtmlEntities("")).toBe("");
	});
});

describe("parseOgp", () => {
	it("extracts all og:* tags", () => {
		const html = `
		<html>
		<head>
			<meta property="og:title" content="Test Title">
			<meta property="og:description" content="Test Description">
			<meta property="og:image" content="https://example.com/image.png">
			<meta property="og:site_name" content="Example Site">
			<title>Fallback Title</title>
		</head>
		</html>
		`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.title).toBe("Test Title");
		expect(ogp.description).toBe("Test Description");
		expect(ogp.image).toBe("https://example.com/image.png");
		expect(ogp.siteName).toBe("Example Site");
		expect(ogp.url).toBe("https://example.com");
	});

	it("falls back to <title> when og:title is missing", () => {
		const html = `<html><head><title>Fallback Title</title></head></html>`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.title).toBe("Fallback Title");
		expect(ogp.description).toBeNull();
		expect(ogp.image).toBeNull();
	});

	it("decodes HTML entities in og:* values", () => {
		const html = `
		<html>
		<head>
			<meta property="og:title" content="Title &amp; More &lt;3&gt;">
			<meta property="og:description" content="It&#39;s &quot;great&quot;">
		</head>
		</html>
		`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.title).toBe("Title & More <3>");
		expect(ogp.description).toBe('It\'s "great"');
	});

	it("returns nulls for empty html", () => {
		const ogp = parseOgp("", "https://example.com");
		expect(ogp.title).toBeNull();
		expect(ogp.description).toBeNull();
		expect(ogp.image).toBeNull();
		expect(ogp.siteName).toBeNull();
	});

	it("returns nulls for html without head", () => {
		const ogp = parseOgp("<html><body>Hello</body></html>", "https://example.com");
		expect(ogp.title).toBeNull();
	});

	it("supports single-quoted attributes", () => {
		const html = `
		<html><head>
			<meta property='og:title' content='Single Quote Title'>
		</head></html>
		`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.title).toBe("Single Quote Title");
	});

	it("supports content attribute before property attribute", () => {
		const html = `<html><head><meta content="Title First" property="og:title"></head></html>`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.title).toBe("Title First");
	});

	it("ignores unrelated meta tags", () => {
		const html = `
		<html><head>
			<meta charset="utf-8">
			<meta name="viewport" content="width=device-width">
			<meta property="og:title" content="Real Title">
		</head></html>
		`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.title).toBe("Real Title");
	});

	it("does not match data-property as property (attribute boundary)", () => {
		const html = `
		<html><head>
			<meta data-property="og:title" content="Spoof Title">
			<meta property="og:title" content="Real Title">
		</head></html>
		`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.title).toBe("Real Title");
	});

	it("does not match data-content as content (attribute boundary)", () => {
		// content 属性が無いケースは null を返す（data-content は誤マッチしない）。
		const html = `<html><head><meta property="og:title" data-content="Spoof"></head></html>`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.title).toBeNull();
	});

	it("matches even when attributes have arbitrary order", () => {
		const html = `<html><head><meta content="Reversed" property="og:title"></head></html>`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.title).toBe("Reversed");
	});

	it("does not confuse og:image with og:image_alt or similar", () => {
		const html = `
		<html><head>
			<meta property="og:image_alt" content="alt text">
			<meta property="og:image" content="https://e.com/i.png">
		</head></html>
		`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.image).toBe("https://e.com/i.png");
	});

	it("title tag with attributes", () => {
		const html = `<html><head><title lang="ja">日本語タイトル</title></head></html>`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.title).toBe("日本語タイトル");
	});

	it("treats empty content as no value", () => {
		const html = `<html><head><meta property="og:title" content=""><title>Backup</title></head></html>`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.title).toBe("Backup");
	});

	it("trims whitespace from <title> content", () => {
		const html = `<html><head><title>   Padded   </title></head></html>`;
		const ogp = parseOgp(html, "https://example.com");
		expect(ogp.title).toBe("Padded");
	});
});
