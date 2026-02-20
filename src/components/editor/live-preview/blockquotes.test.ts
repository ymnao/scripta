import { describe, expect, it } from "vitest";
import { buildDecorations } from "./blockquotes";
import {
	collectDecorations,
	createViewForTest,
	lineDecorations,
	replaceDecorations,
} from "./test-helper";

describe("buildDecorations", () => {
	it("creates line + replace decorations for a single-line blockquote", () => {
		const view = createViewForTest("text\n\n> hello");
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		const replaces = replaceDecorations(decos);
		expect(lines).toHaveLength(1);
		expect(replaces).toHaveLength(1);
	});

	it("applies cm-blockquote-line class to line decorations", () => {
		const view = createViewForTest("text\n\n> hello");
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		expect(lines[0].value.spec.attributes.class).toBe("cm-blockquote-line");
	});

	it("replace range covers QuoteMark and trailing space", () => {
		const doc = "text\n\n> hello";
		const view = createViewForTest(doc);
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		const quoteStart = doc.indexOf("> ");
		expect(replaces[0].from).toBe(quoteStart);
		expect(replaces[0].to).toBe(quoteStart + 2);
	});

	it("creates decorations for all lines of a multi-line blockquote", () => {
		const view = createViewForTest("text\n\n> line1\n> line2\n> line3");
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		const replaces = replaceDecorations(decos);
		expect(lines).toHaveLength(3);
		expect(replaces).toHaveLength(3);
	});

	it("skips entire blockquote when cursor is on any of its lines", () => {
		const doc = "text\n\n> line1\n> line2";
		const cursorPos = doc.indexOf("> line2");
		const view = createViewForTest(doc, cursorPos);
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});

	it("skips entire blockquote when cursor is on first line", () => {
		const doc = "text\n\n> line1\n> line2";
		const cursorPos = doc.indexOf("> line1");
		const view = createViewForTest(doc, cursorPos);
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});

	it("handles > without trailing space", () => {
		const view = createViewForTest("text\n\n>hello");
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		expect(replaces).toHaveLength(1);
		// Only the > character is replaced (no space)
		expect(replaces[0].to - replaces[0].from).toBe(1);
	});

	it("returns empty set for document without blockquotes", () => {
		const view = createViewForTest("hello world\n\nno quotes here");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});
});
