import { describe, expect, it, vi } from "vitest";
import {
	LinkWidget,
	URL_PASTE_RE,
	buildMarkdownLink,
	escapeMarkdownLabel,
	isSafeImageUrl,
	isSafeUrl,
} from "./links";

vi.mock("@tauri-apps/plugin-shell", () => ({}));

describe("isSafeUrl", () => {
	it("allows http URLs", () => {
		expect(isSafeUrl("http://example.com")).toBe(true);
		expect(isSafeUrl("http://example.com/path?q=1")).toBe(true);
	});

	it("allows https URLs", () => {
		expect(isSafeUrl("https://example.com")).toBe(true);
		expect(isSafeUrl("https://example.com/path#section")).toBe(true);
	});

	it("is case-insensitive for scheme", () => {
		expect(isSafeUrl("HTTP://EXAMPLE.COM")).toBe(true);
		expect(isSafeUrl("HTTPS://EXAMPLE.COM")).toBe(true);
		expect(isSafeUrl("Https://Example.com")).toBe(true);
	});

	it("rejects file: URLs", () => {
		expect(isSafeUrl("file:///etc/passwd")).toBe(false);
		expect(isSafeUrl("file://C:/Windows/System32")).toBe(false);
	});

	it("rejects javascript: URLs", () => {
		expect(isSafeUrl("javascript:alert(1)")).toBe(false);
	});

	it("rejects custom scheme URLs", () => {
		expect(isSafeUrl("myapp://open")).toBe(false);
		expect(isSafeUrl("vscode://file/path")).toBe(false);
	});

	it("rejects relative paths", () => {
		expect(isSafeUrl("./image.png")).toBe(false);
		expect(isSafeUrl("../file.md")).toBe(false);
		expect(isSafeUrl("path/to/file")).toBe(false);
	});

	it("rejects empty string", () => {
		expect(isSafeUrl("")).toBe(false);
	});

	it("rejects mailto: and tel:", () => {
		expect(isSafeUrl("mailto:user@example.com")).toBe(false);
		expect(isSafeUrl("tel:+1234567890")).toBe(false);
	});

	it("rejects data: URLs", () => {
		expect(isSafeUrl("data:image/png;base64,iVBORw0KGgo")).toBe(false);
		expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
	});

	it("rejects URLs with whitespace", () => {
		expect(isSafeUrl("http://example.com/path name")).toBe(false);
		expect(isSafeUrl("https://example.com\nmalicious")).toBe(false);
	});
});

describe("isSafeImageUrl", () => {
	it("allows public URLs", () => {
		expect(isSafeImageUrl("https://example.com/image.png")).toBe(true);
		expect(isSafeImageUrl("http://cdn.example.com/photo.jpg")).toBe(true);
	});

	it("rejects localhost", () => {
		expect(isSafeImageUrl("http://localhost/image.png")).toBe(false);
		expect(isSafeImageUrl("http://localhost:8080/image.png")).toBe(false);
	});

	it("rejects loopback IPs", () => {
		expect(isSafeImageUrl("http://127.0.0.1/image.png")).toBe(false);
		expect(isSafeImageUrl("http://127.0.0.1:3000/image.png")).toBe(false);
	});

	it("rejects private 10.x IPs", () => {
		expect(isSafeImageUrl("http://10.0.0.1/image.png")).toBe(false);
	});

	it("rejects private 172.16-31.x IPs", () => {
		expect(isSafeImageUrl("http://172.16.0.1/image.png")).toBe(false);
		expect(isSafeImageUrl("http://172.31.255.255/image.png")).toBe(false);
	});

	it("rejects private 192.168.x IPs", () => {
		expect(isSafeImageUrl("http://192.168.1.1/image.png")).toBe(false);
	});

	it("rejects link-local 169.254.x IPs", () => {
		expect(isSafeImageUrl("http://169.254.0.1/image.png")).toBe(false);
		expect(isSafeImageUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
	});

	it("rejects IPv6 loopback", () => {
		expect(isSafeImageUrl("http://[::1]/image.png")).toBe(false);
	});

	it("rejects 0.0.0.0", () => {
		expect(isSafeImageUrl("http://0.0.0.0/image.png")).toBe(false);
	});

	it("rejects non-http schemes", () => {
		expect(isSafeImageUrl("ftp://example.com/image.png")).toBe(false);
	});

	it("rejects data URLs", () => {
		expect(isSafeImageUrl("data:image/png;base64,abc")).toBe(false);
	});
});

describe("URL_PASTE_RE", () => {
	it("matches http URLs", () => {
		expect(URL_PASTE_RE.test("http://example.com")).toBe(true);
	});

	it("matches https URLs", () => {
		expect(URL_PASTE_RE.test("https://example.com/path?q=1")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(URL_PASTE_RE.test("HTTPS://EXAMPLE.COM")).toBe(true);
	});

	it("rejects non-URL text", () => {
		expect(URL_PASTE_RE.test("just some text")).toBe(false);
	});

	it("rejects text with spaces", () => {
		expect(URL_PASTE_RE.test("https://example.com has spaces")).toBe(false);
	});

	it("rejects ftp URLs", () => {
		expect(URL_PASTE_RE.test("ftp://example.com")).toBe(false);
	});

	it("rejects empty string", () => {
		expect(URL_PASTE_RE.test("")).toBe(false);
	});
});

describe("escapeMarkdownLabel", () => {
	it("escapes square brackets", () => {
		expect(escapeMarkdownLabel("text [with] brackets")).toBe("text \\[with\\] brackets");
	});

	it("escapes backslashes", () => {
		expect(escapeMarkdownLabel("back\\slash")).toBe("back\\\\slash");
	});

	it("escapes backslash before bracket", () => {
		expect(escapeMarkdownLabel("\\]")).toBe("\\\\\\]");
	});

	it("returns plain text unchanged", () => {
		expect(escapeMarkdownLabel("hello world")).toBe("hello world");
	});
});

describe("buildMarkdownLink", () => {
	it("uses selected text as label when provided", () => {
		expect(buildMarkdownLink("https://example.com", "my link")).toBe(
			"[my link](<https://example.com>)",
		);
	});

	it("uses URL as label when selected text is empty", () => {
		expect(buildMarkdownLink("https://example.com", "")).toBe(
			"[https://example.com](<https://example.com>)",
		);
	});

	it("handles URL with parentheses (e.g. Wikipedia)", () => {
		const url = "https://en.wikipedia.org/wiki/Mars_(planet)";
		expect(buildMarkdownLink(url, "Mars")).toBe(`[Mars](<${url}>)`);
	});

	it("escapes brackets in selected text", () => {
		expect(buildMarkdownLink("https://example.com", "see [here]")).toBe(
			"[see \\[here\\]](<https://example.com>)",
		);
	});

	it("preserves special characters in URL", () => {
		expect(buildMarkdownLink("https://example.com/path?q=1&b=2", "link")).toBe(
			"[link](<https://example.com/path?q=1&b=2>)",
		);
	});
});

describe("LinkWidget", () => {
	it("ignoreEvent returns true for mousedown (editor ignores, widget handles)", () => {
		const widget = new LinkWidget("text", "https://example.com");
		const event = new MouseEvent("mousedown");
		expect(widget.ignoreEvent(event)).toBe(true);
	});

	it("ignoreEvent returns true for click (editor ignores, widget handles)", () => {
		const widget = new LinkWidget("text", "https://example.com");
		const event = new MouseEvent("click");
		expect(widget.ignoreEvent(event)).toBe(true);
	});

	it("ignoreEvent returns false for other events (editor handles them)", () => {
		const widget = new LinkWidget("text", "https://example.com");
		const event = new KeyboardEvent("keydown");
		expect(widget.ignoreEvent(event)).toBe(false);
	});
});
