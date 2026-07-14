import { describe, expect, it } from "vitest";
import { buildDecorations, SlideSeparatorWidget } from "./slide-separators";
import {
	collectDecorations,
	createViewForTest,
	replaceDecorations,
	widgetDecorations,
} from "./test-helper";

describe("SlideSeparatorWidget", () => {
	it("eq() returns true for any SlideSeparatorWidget", () => {
		const a = new SlideSeparatorWidget();
		const b = new SlideSeparatorWidget();
		expect(a.eq(b)).toBe(true);
	});

	it("toDOM() creates a div with cm-slide-separator-widget class", () => {
		const widget = new SlideSeparatorWidget();
		const el = widget.toDOM();
		expect(el.tagName).toBe("DIV");
		expect(el.className).toBe("cm-slide-separator-widget");
		expect(el.getAttribute("aria-label")).toBe("スライド区切り");
	});

	it("ignoreEvent() returns true", () => {
		const widget = new SlideSeparatorWidget();
		expect(widget.ignoreEvent()).toBe(true);
	});
});

describe("buildDecorations (slide-separators)", () => {
	it("creates a replace+widget decoration for ---", () => {
		const view = createViewForTest("text\n\n---");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		expect(replaceDecorations(decos)).toHaveLength(1);
	});

	it("handles multiple HRs", () => {
		const doc = "a\n\n---\n\nb\n\n---\n\nc";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view));
		expect(widgetDecorations(decos)).toHaveLength(2);
	});

	it("skips decoration when cursor is on HR line", () => {
		const doc = "text\n\n---";
		const hrPos = doc.indexOf("---");
		const view = createViewForTest(doc, hrPos);
		const decos = collectDecorations(buildDecorations(view));
		expect(widgetDecorations(decos)).toHaveLength(0);
	});

	it("keeps decoration when editor is unfocused even with cursor on HR line", () => {
		const doc = "text\n\n---";
		const hrPos = doc.indexOf("---");
		const view = createViewForTest(doc, hrPos, undefined, false);
		const decos = collectDecorations(buildDecorations(view));
		expect(widgetDecorations(decos)).toHaveLength(1);
	});

	it("returns empty set for document without HRs", () => {
		const view = createViewForTest("hello world\n\nno rules here");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});
});
