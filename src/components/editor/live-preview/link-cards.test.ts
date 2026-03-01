import { describe, expect, it, vi } from "vitest";
import { LinkCardWidget, isStandaloneUrlLine } from "./link-cards";

vi.mock("@tauri-apps/plugin-shell", () => ({}));
vi.mock("../../../lib/commands", () => ({
	fetchOgp: vi.fn(),
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
