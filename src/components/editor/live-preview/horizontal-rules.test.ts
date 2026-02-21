import { describe, expect, it } from "vitest";
import { HRWidget, buildDecorations } from "./horizontal-rules";
import {
	collectDecorations,
	createViewForTest,
	replaceDecorations,
	widgetDecorations,
} from "./test-helper";

describe("HRWidget", () => {
	it("eq() returns true for any HRWidget", () => {
		const a = new HRWidget();
		const b = new HRWidget();
		expect(a.eq(b)).toBe(true);
	});

	it("toDOM() creates an hr element with cm-hr-widget class", () => {
		const widget = new HRWidget();
		const el = widget.toDOM();
		expect(el.tagName).toBe("HR");
		expect(el.className).toBe("cm-hr-widget");
	});

	it("ignoreEvent() returns true", () => {
		const widget = new HRWidget();
		expect(widget.ignoreEvent()).toBe(true);
	});
});

describe("buildDecorations", () => {
	it("creates a replace+widget decoration for ---", () => {
		const view = createViewForTest("text\n\n---");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		expect(replaceDecorations(decos)).toHaveLength(1);
	});

	it("creates a decoration for ***", () => {
		const view = createViewForTest("text\n\n***");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
	});

	it("creates a decoration for ___", () => {
		const view = createViewForTest("text\n\n___");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
	});

	it("handles multiple HRs", () => {
		const doc = "text\n\n---\n\n***\n\n___";
		const view = createViewForTest(doc, doc.indexOf("text"));
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(3);
	});

	it("keeps decoration when cursor is on HR line", () => {
		const doc = "text\n\n---";
		const hrPos = doc.indexOf("---");
		const view = createViewForTest(doc, hrPos);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
	});

	it("returns empty set for document without HRs", () => {
		const view = createViewForTest("hello world\n\nno rules here");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});
});
