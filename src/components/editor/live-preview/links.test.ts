import { describe, expect, it, vi } from "vitest";
import {
	anyRangeInCodeConstruct,
	applyClipboardPasteAsMdLink,
	buildMarkdownLink,
	computeUrlPasteInsert,
	escapeMarkdownLabel,
	isLineOnlyMdLink,
	isOpenLinkModifierEvent,
	isPosInCodeConstruct,
	isPrivateHostname,
	isSafeImageUrl,
	isSafeUrl,
	LinkWidget,
	parseSingleMdLink,
	pasteAsMarkdownLinkCommand,
	shouldConvertPasteToLink,
	URL_PASTE_RE,
} from "./links";
import { createTestState } from "./test-helper";

vi.mock("../../../lib/commands", () => ({
	openExternal: vi.fn(() => Promise.resolve()),
}));

// 各テスト内で参照するために mock 後に import
import { openExternal } from "../../../lib/commands";

const openExternalMock = vi.mocked(openExternal);

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

	it("rejects IPv6-mapped IPv4", () => {
		expect(isSafeImageUrl("http://[::ffff:127.0.0.1]/image.png")).toBe(false);
	});

	it("rejects CGNAT range", () => {
		expect(isSafeImageUrl("http://100.64.0.1/image.png")).toBe(false);
	});

	it("rejects multicast range", () => {
		expect(isSafeImageUrl("http://224.0.0.1/image.png")).toBe(false);
	});
});

describe("isPrivateHostname", () => {
	it("rejects localhost variants", () => {
		expect(isPrivateHostname("localhost")).toBe(true);
		expect(isPrivateHostname("localhost.")).toBe(true);
		expect(isPrivateHostname("sub.localhost")).toBe(true);
	});

	it("rejects empty string", () => {
		expect(isPrivateHostname("")).toBe(true);
	});

	it("rejects IPv6 addresses (all forms)", () => {
		expect(isPrivateHostname("::1")).toBe(true);
		expect(isPrivateHostname("fe80::1")).toBe(true);
		expect(isPrivateHostname("::ffff:127.0.0.1")).toBe(true);
	});

	it("rejects private IPv4", () => {
		expect(isPrivateHostname("10.0.0.1")).toBe(true);
		expect(isPrivateHostname("172.16.0.1")).toBe(true);
		expect(isPrivateHostname("192.168.1.1")).toBe(true);
		expect(isPrivateHostname("127.0.0.1")).toBe(true);
	});

	it("allows public IPs", () => {
		expect(isPrivateHostname("8.8.8.8")).toBe(false);
		expect(isPrivateHostname("1.1.1.1")).toBe(false);
	});

	it("allows public domain names", () => {
		expect(isPrivateHostname("example.com")).toBe(false);
		expect(isPrivateHostname("cdn.example.com")).toBe(false);
	});

	it("rejects invalid IPv4 octets", () => {
		expect(isPrivateHostname("999.999.999.999")).toBe(true);
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

describe("shouldConvertPasteToLink", () => {
	it("converts when selection is non-empty (wraps selection as label)", () => {
		expect(shouldConvertPasteToLink({ hasSelection: true, lineBefore: "", lineAfter: "" })).toBe(
			true,
		);
		expect(shouldConvertPasteToLink({ hasSelection: true, lineBefore: "x", lineAfter: "y" })).toBe(
			true,
		);
	});

	it("does not convert on URL-only line (plain paste lets OGP card start)", () => {
		expect(shouldConvertPasteToLink({ hasSelection: false, lineBefore: "", lineAfter: "" })).toBe(
			false,
		);
	});

	it("treats whitespace-only context as URL-only line", () => {
		expect(
			shouldConvertPasteToLink({ hasSelection: false, lineBefore: "  ", lineAfter: "\t" }),
		).toBe(false);
	});

	it("converts when other text precedes the cursor", () => {
		expect(
			shouldConvertPasteToLink({ hasSelection: false, lineBefore: "prefix ", lineAfter: "" }),
		).toBe(true);
	});

	it("converts when other text follows the cursor", () => {
		expect(
			shouldConvertPasteToLink({ hasSelection: false, lineBefore: "", lineAfter: " suffix" }),
		).toBe(true);
	});

	it("converts when text exists on both sides", () => {
		expect(
			shouldConvertPasteToLink({ hasSelection: false, lineBefore: "a ", lineAfter: " b" }),
		).toBe(true);
	});
});

describe("isPosInCodeConstruct", () => {
	it("returns false for plain text", () => {
		const state = createTestState("hello world");
		expect(isPosInCodeConstruct(state, 3)).toBe(false);
	});

	it("returns true inside fenced code block", () => {
		const doc = "before\n```\ncode here\n```\nafter";
		const state = createTestState(doc);
		const inside = doc.indexOf("code here") + 2;
		expect(isPosInCodeConstruct(state, inside)).toBe(true);
	});

	it("returns true inside inline code", () => {
		const doc = "text `inline code` end";
		const state = createTestState(doc);
		const inside = doc.indexOf("inline code") + 2;
		expect(isPosInCodeConstruct(state, inside)).toBe(true);
	});

	it("returns false in normal text adjacent to code block", () => {
		const doc = "outside\n```\ncode\n```\nalso outside";
		const state = createTestState(doc);
		expect(isPosInCodeConstruct(state, 2)).toBe(false);
	});
});

describe("anyRangeInCodeConstruct", () => {
	it("returns false when no range is in code", () => {
		const state = createTestState("plain text", 3);
		expect(anyRangeInCodeConstruct(state)).toBe(false);
	});

	it("returns true when sole range is inside fenced code", () => {
		const doc = "```\ncode\n```";
		const state = createTestState(doc, doc.indexOf("code") + 2);
		expect(anyRangeInCodeConstruct(state)).toBe(true);
	});

	it("returns false when sole range is outside code (mixed-line variant)", () => {
		const doc = "text `inline` more";
		const state = createTestState(doc, 16); // cursor in " more"
		expect(anyRangeInCodeConstruct(state)).toBe(false);
	});
});

describe("computeUrlPasteInsert", () => {
	const base = {
		text: "https://example.com",
		hasSelection: false,
		selectedText: "",
		lineBefore: "",
		lineAfter: "",
	};

	it("inserts plain text when inside code block (forceConvert ignored)", () => {
		expect(computeUrlPasteInsert({ ...base, forceConvert: true, inCodeBlock: true })).toBe(
			"https://example.com",
		);
		expect(computeUrlPasteInsert({ ...base, forceConvert: false, inCodeBlock: true })).toBe(
			"https://example.com",
		);
	});

	it("Cmd+V on URL-only line: inserts plain (let OGP card start)", () => {
		expect(computeUrlPasteInsert({ ...base, forceConvert: false, inCodeBlock: false })).toBe(
			"https://example.com",
		);
	});

	it("Cmd+V on mixed line: converts to md link", () => {
		expect(
			computeUrlPasteInsert({
				...base,
				lineBefore: "see ",
				forceConvert: false,
				inCodeBlock: false,
			}),
		).toBe("[https://example.com](<https://example.com>)");
	});

	it("Cmd+Shift+V on URL-only line: still converts (force)", () => {
		expect(computeUrlPasteInsert({ ...base, forceConvert: true, inCodeBlock: false })).toBe(
			"[https://example.com](<https://example.com>)",
		);
	});

	it("Cmd+Shift+V with selection: uses selection as label", () => {
		expect(
			computeUrlPasteInsert({
				...base,
				hasSelection: true,
				selectedText: "example site",
				forceConvert: true,
				inCodeBlock: false,
			}),
		).toBe("[example site](<https://example.com>)");
	});
});

describe("applyClipboardPasteAsMdLink", () => {
	function makeView(doc: string, cursorPos: number) {
		const state = createTestState(doc, cursorPos);
		const dispatched: Array<{ insert: string; userEvent: string | undefined }> = [];
		const view = {
			state,
			dispatch: (spec: {
				changes?: {
					iterChanges: (
						cb: (a: number, b: number, c: number, d: number, ins: { toString(): string }) => void,
					) => void;
				};
				userEvent?: string;
			}) => {
				if (!spec.changes) return;
				let insert = "";
				spec.changes.iterChanges((_fromA, _toA, _fromB, _toB, ins) => {
					insert += ins.toString();
				});
				dispatched.push({ insert, userEvent: spec.userEvent });
			},
		} as unknown as Parameters<typeof applyClipboardPasteAsMdLink>[0];
		return { view, dispatched };
	}

	it("inserts md link when clipboard is a URL (force convert even on empty line)", () => {
		const { view, dispatched } = makeView("", 0);
		applyClipboardPasteAsMdLink(view, "https://example.com");
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].insert).toBe("[https://example.com](<https://example.com>)");
		expect(dispatched[0].userEvent).toBe("input.paste");
	});

	it("inserts plain text when clipboard is not a URL", () => {
		const { view, dispatched } = makeView("", 0);
		applyClipboardPasteAsMdLink(view, "just some text");
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].insert).toBe("just some text");
		expect(dispatched[0].userEvent).toBe("input.paste");
	});

	it("does nothing when clipboard is empty/whitespace", () => {
		const { view, dispatched } = makeView("", 0);
		applyClipboardPasteAsMdLink(view, "   ");
		expect(dispatched).toHaveLength(0);
	});

	it("does nothing when clipboard is null", () => {
		const { view, dispatched } = makeView("", 0);
		applyClipboardPasteAsMdLink(view, null);
		expect(dispatched).toHaveLength(0);
	});

	it("inserts plain URL when cursor is in a code block (force convert overridden)", () => {
		const doc = "```\ncode\n```";
		const inCode = doc.indexOf("code") + 2;
		const { view, dispatched } = makeView(doc, inCode);
		applyClipboardPasteAsMdLink(view, "https://example.com");
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0].insert).toBe("https://example.com");
	});

	it("trims whitespace from clipboard before checking URL pattern", () => {
		const { view, dispatched } = makeView("", 0);
		applyClipboardPasteAsMdLink(view, "  https://example.com\n");
		expect(dispatched[0].insert).toBe("[https://example.com](<https://example.com>)");
	});
});

describe("pasteAsMarkdownLinkCommand", () => {
	it("returns false when clipboard is unavailable", () => {
		const original = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
		try {
			const state = createTestState("hello", 0);
			const view = { state, dispatch: vi.fn() } as unknown as Parameters<
				typeof pasteAsMarkdownLinkCommand
			>[0];
			expect(pasteAsMarkdownLinkCommand(view)).toBe(false);
		} finally {
			if (original) {
				Object.defineProperty(navigator, "clipboard", { value: original, configurable: true });
			}
		}
	});

	it("returns true when clipboard is available (defers actual work to .then)", () => {
		const original = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", {
			value: { readText: () => Promise.resolve("https://example.com") },
			configurable: true,
		});
		try {
			const state = createTestState("", 0);
			const view = { state, dispatch: vi.fn() } as unknown as Parameters<
				typeof pasteAsMarkdownLinkCommand
			>[0];
			expect(pasteAsMarkdownLinkCommand(view)).toBe(true);
		} finally {
			if (original) {
				Object.defineProperty(navigator, "clipboard", { value: original, configurable: true });
			}
		}
	});
});

describe("isOpenLinkModifierEvent", () => {
	it("returns true for metaKey (Cmd)", () => {
		const e = new MouseEvent("click", { metaKey: true });
		expect(isOpenLinkModifierEvent(e)).toBe(true);
	});

	it("returns true for ctrlKey", () => {
		const e = new MouseEvent("click", { ctrlKey: true });
		expect(isOpenLinkModifierEvent(e)).toBe(true);
	});

	it("returns false for plain event", () => {
		const e = new MouseEvent("click");
		expect(isOpenLinkModifierEvent(e)).toBe(false);
	});

	it("returns false for shift-only event", () => {
		const e = new MouseEvent("click", { shiftKey: true });
		expect(isOpenLinkModifierEvent(e)).toBe(false);
	});
});

describe("parseSingleMdLink", () => {
	it("parses angle-bracket form `[label](<url>)`", () => {
		expect(parseSingleMdLink("[Example](<https://example.com>)")).toEqual({
			label: "Example",
			url: "https://example.com",
			from: 0,
			to: "[Example](<https://example.com>)".length,
		});
	});

	it("parses plain form `[label](url)`", () => {
		expect(parseSingleMdLink("[Example](https://example.com)")).toEqual({
			label: "Example",
			url: "https://example.com",
			from: 0,
			to: "[Example](https://example.com)".length,
		});
	});

	it("returns null for plain text", () => {
		expect(parseSingleMdLink("hello world")).toBeNull();
	});

	it("returns null when only opening bracket", () => {
		expect(parseSingleMdLink("[Example")).toBeNull();
	});

	it("unescapes backslash sequences in label", () => {
		expect(parseSingleMdLink("[a\\]b](<https://x>)")?.label).toBe("a]b");
	});

	it("finds link offset within larger string", () => {
		const result = parseSingleMdLink("prefix [Example](<https://example.com>) suffix");
		expect(result?.from).toBe(7);
		expect(result?.label).toBe("Example");
	});

	it("returns null when URL is empty (angle form)", () => {
		expect(parseSingleMdLink("[label](<>)")).toBeNull();
	});
});

describe("isLineOnlyMdLink", () => {
	it("returns true when link spans the entire line", () => {
		const text = "[a](<https://x>)";
		expect(isLineOnlyMdLink(text, 0, 0, text.length, text.length)).toBe(true);
	});

	it("returns true when only whitespace surrounds the link", () => {
		const text = "  [a](<https://x>)  ";
		const link = "[a](<https://x>)";
		const linkStart = text.indexOf(link);
		expect(isLineOnlyMdLink(text, 0, linkStart, linkStart + link.length, text.length)).toBe(true);
	});

	it("returns false when text precedes the link", () => {
		const text = "see [a](<https://x>)";
		const link = "[a](<https://x>)";
		const linkStart = text.indexOf(link);
		expect(isLineOnlyMdLink(text, 0, linkStart, linkStart + link.length, text.length)).toBe(false);
	});

	it("returns false when text follows the link", () => {
		const text = "[a](<https://x>) end";
		const link = "[a](<https://x>)";
		expect(isLineOnlyMdLink(text, 0, 0, link.length, text.length)).toBe(false);
	});

	it("handles line range that does not start at 0 (lineFrom offset applied)", () => {
		// e.g. line starts at doc pos 10
		const lineText = "[a](<https://x>)";
		const lineFrom = 10;
		expect(
			isLineOnlyMdLink(lineText, lineFrom, 10, 10 + lineText.length, lineFrom + lineText.length),
		).toBe(true);
	});
});

describe("LinkWidget", () => {
	// マウス系・contextmenu は CM-level handler で gate するため editor に渡す → false
	it("ignoreEvent returns false for mousedown (regardless of modifier)", () => {
		const widget = new LinkWidget("text", "https://example.com");
		expect(widget.ignoreEvent(new MouseEvent("mousedown"))).toBe(false);
		expect(widget.ignoreEvent(new MouseEvent("mousedown", { metaKey: true }))).toBe(false);
	});

	it("ignoreEvent returns false for click (regardless of modifier)", () => {
		const widget = new LinkWidget("text", "https://example.com");
		expect(widget.ignoreEvent(new MouseEvent("click"))).toBe(false);
		expect(widget.ignoreEvent(new MouseEvent("click", { metaKey: true }))).toBe(false);
		expect(widget.ignoreEvent(new MouseEvent("click", { ctrlKey: true }))).toBe(false);
	});

	it("ignoreEvent returns false for contextmenu (CM handler dispatches custom event)", () => {
		const widget = new LinkWidget("text", "https://example.com");
		expect(widget.ignoreEvent(new MouseEvent("contextmenu"))).toBe(false);
	});

	it("ignoreEvent returns true for keyboard events (widget handles Enter/Space)", () => {
		const widget = new LinkWidget("text", "https://example.com");
		expect(widget.ignoreEvent(new KeyboardEvent("keydown"))).toBe(true);
		expect(widget.ignoreEvent(new KeyboardEvent("keyup"))).toBe(true);
	});

	it("ignoreEvent returns true for unknown event types", () => {
		const widget = new LinkWidget("text", "https://example.com");
		expect(widget.ignoreEvent(new Event("focus"))).toBe(true);
	});

	it("toDOM does not set href (CM handler reads dataset.linkWidgetUrl instead)", () => {
		// href があると Chromium の cmd+click が新規ウィンドウを開こうとして競合する
		const widget = new LinkWidget("Example", "https://example.com");
		const el = widget.toDOM();
		expect(el.getAttribute("href")).toBeNull();
		expect((el as HTMLAnchorElement).dataset.linkWidgetUrl).toBe("https://example.com");
	});

	it("toDOM disabled link does not set dataset.linkWidgetUrl (unsafe URL)", () => {
		const widget = new LinkWidget("Example", "ftp://example.com");
		const el = widget.toDOM();
		expect((el as HTMLAnchorElement).dataset.linkWidgetUrl).toBeUndefined();
		expect(el.classList.contains("cm-link-widget-disabled")).toBe(true);
	});

	describe("widget DOM mousedown listener (defense-in-depth for cmd+click)", () => {
		it("opens URL on cmd+left-click via widget DOM listener", () => {
			openExternalMock.mockClear();
			const widget = new LinkWidget("Example", "https://example.com");
			const el = widget.toDOM();
			document.body.appendChild(el);
			try {
				const ev = new MouseEvent("mousedown", {
					bubbles: true,
					cancelable: true,
					button: 0,
					metaKey: true,
				});
				el.dispatchEvent(ev);
				expect(openExternalMock).toHaveBeenCalledWith("https://example.com");
				expect(ev.defaultPrevented).toBe(true);
			} finally {
				el.remove();
			}
		});

		it("opens URL on ctrl+left-click", () => {
			openExternalMock.mockClear();
			const widget = new LinkWidget("Example", "https://example.com");
			const el = widget.toDOM();
			document.body.appendChild(el);
			try {
				el.dispatchEvent(
					new MouseEvent("mousedown", {
						bubbles: true,
						cancelable: true,
						button: 0,
						ctrlKey: true,
					}),
				);
				expect(openExternalMock).toHaveBeenCalledWith("https://example.com");
			} finally {
				el.remove();
			}
		});

		it("does NOT open URL on plain left-click (lets editor move cursor)", () => {
			openExternalMock.mockClear();
			const widget = new LinkWidget("Example", "https://example.com");
			const el = widget.toDOM();
			document.body.appendChild(el);
			try {
				const ev = new MouseEvent("mousedown", {
					bubbles: true,
					cancelable: true,
					button: 0,
				});
				el.dispatchEvent(ev);
				expect(openExternalMock).not.toHaveBeenCalled();
				expect(ev.defaultPrevented).toBe(false);
			} finally {
				el.remove();
			}
		});

		it("does NOT open URL on right-click (cmd+right shouldn't open either)", () => {
			openExternalMock.mockClear();
			const widget = new LinkWidget("Example", "https://example.com");
			const el = widget.toDOM();
			document.body.appendChild(el);
			try {
				el.dispatchEvent(
					new MouseEvent("mousedown", {
						bubbles: true,
						cancelable: true,
						button: 2,
						metaKey: true,
					}),
				);
				expect(openExternalMock).not.toHaveBeenCalled();
			} finally {
				el.remove();
			}
		});

		it("stops propagation on cmd+click so CM built-in selection never sees it", () => {
			openExternalMock.mockClear();
			const widget = new LinkWidget("Example", "https://example.com");
			const el = widget.toDOM();
			const parent = document.createElement("div");
			parent.appendChild(el);
			document.body.appendChild(parent);
			let bubbled = false;
			parent.addEventListener("mousedown", () => {
				bubbled = true;
			});
			try {
				el.dispatchEvent(
					new MouseEvent("mousedown", {
						bubbles: true,
						cancelable: true,
						button: 0,
						metaKey: true,
					}),
				);
				expect(bubbled).toBe(false);
			} finally {
				parent.remove();
			}
		});

		it("does NOT open URL when widget is disabled (unsafe URL)", () => {
			openExternalMock.mockClear();
			const widget = new LinkWidget("Example", "ftp://example.com");
			const el = widget.toDOM();
			document.body.appendChild(el);
			try {
				el.dispatchEvent(
					new MouseEvent("mousedown", {
						bubbles: true,
						cancelable: true,
						button: 0,
						metaKey: true,
					}),
				);
				expect(openExternalMock).not.toHaveBeenCalled();
			} finally {
				el.remove();
			}
		});
	});
});
