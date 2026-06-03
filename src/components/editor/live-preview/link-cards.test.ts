import type { Transaction } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import {
	buildMdLinkFromCard,
	containsPasteUserEvent,
	getCardDeleteRange,
	isStandaloneUrlLine,
	LinkCardWidget,
} from "./link-cards";

vi.mock("../../../lib/commands", () => ({
	fetchOgp: vi.fn(),
	openExternal: vi.fn(),
}));

describe("isStandaloneUrlLine", () => {
	it("detects a simple http URL", () => {
		expect(isStandaloneUrlLine("http://example.com")).toBe("http://example.com");
	});

	it("detects a simple https URL", () => {
		expect(isStandaloneUrlLine("https://example.com")).toBe("https://example.com");
	});

	it("detects URL with path and query", () => {
		expect(isStandaloneUrlLine("https://example.com/path?q=1")).toBe(
			"https://example.com/path?q=1",
		);
	});

	it("detects URL with leading/trailing whitespace", () => {
		expect(isStandaloneUrlLine("  https://example.com  ")).toBe("https://example.com");
	});

	it("returns null for inline text with URL", () => {
		expect(isStandaloneUrlLine("Check out https://example.com for more")).toBeNull();
	});

	it("returns null for Markdown link syntax", () => {
		expect(isStandaloneUrlLine("[text](https://example.com)")).toBeNull();
	});

	it("returns null for ftp URLs", () => {
		expect(isStandaloneUrlLine("ftp://example.com")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(isStandaloneUrlLine("")).toBeNull();
	});

	it("returns null for whitespace-only string", () => {
		expect(isStandaloneUrlLine("   ")).toBeNull();
	});
});

describe("buildMdLinkFromCard", () => {
	it("uses OGP title as label when available", () => {
		expect(buildMdLinkFromCard("https://example.com", "Example Site")).toBe(
			"[Example Site](<https://example.com>)",
		);
	});

	it("falls back to URL when title is null", () => {
		expect(buildMdLinkFromCard("https://example.com", null)).toBe(
			"[https://example.com](<https://example.com>)",
		);
	});

	it("falls back to URL when title is undefined", () => {
		expect(buildMdLinkFromCard("https://example.com")).toBe(
			"[https://example.com](<https://example.com>)",
		);
	});

	it("falls back to URL when title is empty/whitespace", () => {
		expect(buildMdLinkFromCard("https://example.com", "   ")).toBe(
			"[https://example.com](<https://example.com>)",
		);
	});

	it("trims title before using as label", () => {
		expect(buildMdLinkFromCard("https://example.com", "  Title  ")).toBe(
			"[Title](<https://example.com>)",
		);
	});

	it("escapes square brackets in title", () => {
		expect(buildMdLinkFromCard("https://example.com", "Foo [bar]")).toBe(
			"[Foo \\[bar\\]](<https://example.com>)",
		);
	});

	it("uses angle bracket URL form (URL not escaped)", () => {
		// `)` を含む URL でもリンクが壊れないことを保証
		expect(buildMdLinkFromCard("https://en.wikipedia.org/wiki/Foo_(bar)", "Wikipedia")).toBe(
			"[Wikipedia](<https://en.wikipedia.org/wiki/Foo_(bar)>)",
		);
	});
});

describe("getCardDeleteRange", () => {
	// Lightweight doc shape that matches what link-cards.ts uses
	function makeDoc(lines: string[]) {
		const fullText = lines.join("\n");
		const lineStarts: number[] = [0];
		for (let i = 0; i < lines.length - 1; i++) {
			lineStarts.push(lineStarts[i] + lines[i].length + 1);
		}
		return {
			length: fullText.length,
			lines: lines.length,
			lineAt: (pos: number) => {
				let lineNum = lines.length;
				for (let i = lines.length - 1; i >= 0; i--) {
					if (pos >= lineStarts[i]) {
						lineNum = i + 1;
						break;
					}
				}
				const idx = lineNum - 1;
				return {
					from: lineStarts[idx],
					to: lineStarts[idx] + lines[idx].length,
					number: lineNum,
				};
			},
		};
	}

	it("middle line: deletes line + trailing newline (upper/lower lines join)", () => {
		const doc = makeDoc(["a", "URL", "b"]);
		const range = getCardDeleteRange(doc, 2); // pos in "URL" line
		expect(range).toEqual({ from: 2, to: 6 }); // "URL\n" range
	});

	it("last line: deletes leading newline + line (no empty line left)", () => {
		const doc = makeDoc(["a", "URL"]);
		const range = getCardDeleteRange(doc, 2);
		expect(range).toEqual({ from: 1, to: 5 }); // "\nURL"
	});

	it("only line in doc: deletes line content only (no newline to consume)", () => {
		const doc = makeDoc(["URL"]);
		const range = getCardDeleteRange(doc, 0);
		expect(range).toEqual({ from: 0, to: 3 });
	});

	it("first line of multi-line doc: deletes line + newline", () => {
		const doc = makeDoc(["URL", "b"]);
		const range = getCardDeleteRange(doc, 0);
		expect(range).toEqual({ from: 0, to: 4 }); // "URL\n"
	});
});

describe("containsPasteUserEvent", () => {
	function fakeTr(userEvent: string | null): Transaction {
		return {
			isUserEvent(name: string) {
				if (userEvent == null) return false;
				return userEvent === name || userEvent.startsWith(`${name}.`);
			},
		} as unknown as Transaction;
	}

	it("returns false for empty transactions array", () => {
		expect(containsPasteUserEvent([])).toBe(false);
	});

	it("returns true when a transaction has input.paste userEvent", () => {
		expect(containsPasteUserEvent([fakeTr("input.paste")])).toBe(true);
	});

	it("returns true when any transaction in the list has input.paste", () => {
		expect(containsPasteUserEvent([fakeTr("input.type"), fakeTr("input.paste")])).toBe(true);
	});

	it("returns false for typing-only transactions", () => {
		expect(containsPasteUserEvent([fakeTr("input.type"), fakeTr("delete.backward")])).toBe(false);
	});

	it("matches sub-events of input.paste (e.g. input.paste.markdown)", () => {
		expect(containsPasteUserEvent([fakeTr("input.paste.markdown")])).toBe(true);
	});

	it("returns false when userEvent is null/absent", () => {
		expect(containsPasteUserEvent([fakeTr(null)])).toBe(false);
	});
});

describe("LinkCardWidget", () => {
	describe("eq", () => {
		it("returns true for same URL and null ogp", () => {
			const a = new LinkCardWidget("https://example.com", null);
			const b = new LinkCardWidget("https://example.com", null);
			expect(a.eq(b)).toBe(true);
		});

		it("returns false for different URLs", () => {
			const a = new LinkCardWidget("https://example.com", null);
			const b = new LinkCardWidget("https://other.com", null);
			expect(a.eq(b)).toBe(false);
		});

		it("returns true for same URL and same ogp", () => {
			const ogp = {
				title: "Title",
				description: "Desc",
				image: "https://img.com/a.png",
				siteName: "Site",
				url: "https://example.com",
			};
			const a = new LinkCardWidget("https://example.com", ogp);
			const b = new LinkCardWidget("https://example.com", { ...ogp });
			expect(a.eq(b)).toBe(true);
		});

		it("returns false when ogp changes", () => {
			const ogp1 = {
				title: "Title",
				description: "Desc",
				image: null,
				siteName: null,
				url: "https://example.com",
			};
			const ogp2 = {
				title: "New Title",
				description: "Desc",
				image: null,
				siteName: null,
				url: "https://example.com",
			};
			const a = new LinkCardWidget("https://example.com", ogp1);
			const b = new LinkCardWidget("https://example.com", ogp2);
			expect(a.eq(b)).toBe(false);
		});

		it("returns false when one ogp is null and other is not", () => {
			const ogp = {
				title: "Title",
				description: null,
				image: null,
				siteName: null,
				url: "https://example.com",
			};
			const a = new LinkCardWidget("https://example.com", null);
			const b = new LinkCardWidget("https://example.com", ogp);
			expect(a.eq(b)).toBe(false);
		});
	});

	describe("toDOM", () => {
		it("renders loading state when ogp is null", () => {
			const widget = new LinkCardWidget("https://example.com", null);
			const dom = widget.toDOM() as HTMLAnchorElement;
			expect(dom.className).toBe("cm-link-card");
			expect(dom.tagName).toBe("A");
			expect(dom.dataset.linkCardUrl).toBe("https://example.com");
			const loading = dom.querySelector(".cm-link-card-loading");
			expect(loading).not.toBeNull();
			expect(loading?.textContent).toBe("example.com");
		});

		it("renders card with title and description when ogp is loaded", () => {
			const ogp = {
				title: "Example Title",
				description: "Example Description",
				image: null,
				siteName: "Example",
				url: "https://example.com",
			};
			const widget = new LinkCardWidget("https://example.com", ogp);
			const dom = widget.toDOM();
			const title = dom.querySelector(".cm-link-card-title");
			expect(title?.textContent).toBe("Example Title");
			const desc = dom.querySelector(".cm-link-card-description");
			expect(desc?.textContent).toBe("Example Description");
			const domain = dom.querySelector(".cm-link-card-domain");
			expect(domain?.textContent).toBe("Example");
		});

		it("renders thumbnail when image is provided", () => {
			const ogp = {
				title: "Title",
				description: null,
				image: "https://example.com/image.png",
				siteName: null,
				url: "https://example.com",
			};
			const widget = new LinkCardWidget("https://example.com", ogp);
			const dom = widget.toDOM();
			const img = dom.querySelector(".cm-link-card-thumbnail") as HTMLImageElement;
			expect(img).not.toBeNull();
			expect(img.src).toBe("https://example.com/image.png");
		});

		it("resolves relative image URL using ogp.url as base", () => {
			const ogp = {
				title: "Title",
				description: null,
				image: "/og.png",
				siteName: null,
				url: "https://example.com/page",
			};
			const widget = new LinkCardWidget("https://example.com/page", ogp);
			const dom = widget.toDOM();
			const img = dom.querySelector(".cm-link-card-thumbnail") as HTMLImageElement;
			expect(img).not.toBeNull();
			expect(img.src).toBe("https://example.com/og.png");
		});

		it("resolves relative image URL using card url when ogp.url is empty", () => {
			const ogp = {
				title: "Title",
				description: null,
				image: "/images/thumb.jpg",
				siteName: null,
				url: "",
			};
			const widget = new LinkCardWidget("https://other.com/page", ogp);
			const dom = widget.toDOM();
			const img = dom.querySelector(".cm-link-card-thumbnail") as HTMLImageElement;
			expect(img).not.toBeNull();
			expect(img.src).toBe("https://other.com/images/thumb.jpg");
		});

		it("skips thumbnail when image URL resolution fails", () => {
			const ogp = {
				title: "Title",
				description: null,
				image: "://invalid",
				siteName: null,
				url: "",
			};
			const widget = new LinkCardWidget("not-a-url", ogp);
			const dom = widget.toDOM();
			const img = dom.querySelector(".cm-link-card-thumbnail");
			expect(img).toBeNull();
		});

		it("shows domain name when siteName is null", () => {
			const ogp = {
				title: "Title",
				description: null,
				image: null,
				siteName: null,
				url: "https://example.com",
			};
			const widget = new LinkCardWidget("https://example.com", ogp);
			const dom = widget.toDOM();
			const domain = dom.querySelector(".cm-link-card-domain");
			expect(domain?.textContent).toBe("example.com");
		});
	});

	describe("ignoreEvent", () => {
		it("returns true for mousedown (editor ignores, widget handles)", () => {
			const widget = new LinkCardWidget("https://example.com", null);
			const event = new MouseEvent("mousedown");
			expect(widget.ignoreEvent(event)).toBe(true);
		});

		it("returns true for click (editor ignores, widget handles)", () => {
			const widget = new LinkCardWidget("https://example.com", null);
			const event = new MouseEvent("click");
			expect(widget.ignoreEvent(event)).toBe(true);
		});

		it("returns false for other events (editor handles them)", () => {
			const widget = new LinkCardWidget("https://example.com", null);
			const event = new KeyboardEvent("keydown");
			expect(widget.ignoreEvent(event)).toBe(false);
		});
	});
});
