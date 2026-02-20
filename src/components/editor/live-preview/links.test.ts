import { describe, expect, it } from "vitest";
import { isSafeUrl } from "./links";

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
