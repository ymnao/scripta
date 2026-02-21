import { describe, expect, it } from "vitest";
import { BulletWidget, CheckboxWidget, buildDecorations, listKeymap } from "./lists";
import {
	collectDecorations,
	createTestState,
	createViewForTest,
	markDecorations,
	replaceDecorations,
	widgetDecorations,
} from "./test-helper";

describe("CheckboxWidget", () => {
	it("eq() returns true for same checked and pos", () => {
		const a = new CheckboxWidget(true, 5);
		const b = new CheckboxWidget(true, 5);
		expect(a.eq(b)).toBe(true);
	});

	it("eq() returns false for different checked", () => {
		const a = new CheckboxWidget(true, 5);
		const b = new CheckboxWidget(false, 5);
		expect(a.eq(b)).toBe(false);
	});

	it("eq() returns false for different pos", () => {
		const a = new CheckboxWidget(true, 5);
		const b = new CheckboxWidget(true, 10);
		expect(a.eq(b)).toBe(false);
	});

	it("toDOM() creates a span with correct attributes when checked", () => {
		const widget = new CheckboxWidget(true, 42);
		const el = widget.toDOM();
		expect(el.tagName).toBe("SPAN");
		expect(el.classList.contains("cm-task-checkbox")).toBe(true);
		expect(el.classList.contains("cm-task-checkbox-checked")).toBe(true);
		expect(el.dataset.pos).toBe("42");
		expect(el.getAttribute("role")).toBe("checkbox");
		expect(el.getAttribute("aria-checked")).toBe("true");
		expect(el.getAttribute("aria-label")).toBe("Toggle task");
		const svg = el.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg?.classList.contains("cm-task-checkmark")).toBe(true);
	});

	it("toDOM() creates unchecked span without SVG", () => {
		const widget = new CheckboxWidget(false, 0);
		const el = widget.toDOM();
		expect(el.tagName).toBe("SPAN");
		expect(el.classList.contains("cm-task-checkbox")).toBe(true);
		expect(el.classList.contains("cm-task-checkbox-checked")).toBe(false);
		expect(el.getAttribute("aria-checked")).toBe("false");
		expect(el.querySelector("svg")).toBeNull();
	});

	it("ignoreEvent() returns false", () => {
		const widget = new CheckboxWidget(false, 0);
		expect(widget.ignoreEvent()).toBe(false);
	});
});

describe("BulletWidget", () => {
	it("eq() always returns true", () => {
		const a = new BulletWidget();
		const b = new BulletWidget();
		expect(a.eq(b)).toBe(true);
	});

	it("toDOM() creates a span with bullet character", () => {
		const widget = new BulletWidget();
		const el = widget.toDOM();
		expect(el.tagName).toBe("SPAN");
		expect(el.className).toBe("cm-bullet-mark");
		expect(el.textContent).toBe("•");
	});

	it("ignoreEvent() returns true", () => {
		const widget = new BulletWidget();
		expect(widget.ignoreEvent()).toBe(true);
	});
});

describe("buildDecorations", () => {
	it("creates replace decorations for a task item", () => {
		const view = createViewForTest("text\n\n- [ ] task");
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		// 1 replace for ListMark+space, 1 replace+widget for TaskMarker
		expect(replaces).toHaveLength(2);
	});

	it("widget has checked=false for [ ]", () => {
		const view = createViewForTest("text\n\n- [ ] task");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const widget = widgets[0].value.spec.widget as CheckboxWidget;
		expect(widget.checked).toBe(false);
	});

	it("widget has checked=true for [x]", () => {
		const view = createViewForTest("text\n\n- [x] task");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const widget = widgets[0].value.spec.widget as CheckboxWidget;
		expect(widget.checked).toBe(true);
	});

	it("widget has checked=true for [X] (uppercase)", () => {
		const view = createViewForTest("text\n\n- [X] task");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const widget = widgets[0].value.spec.widget as CheckboxWidget;
		expect(widget.checked).toBe(true);
	});

	it("handles multiple task items", () => {
		const doc = "text\n\n- [ ] one\n- [x] two\n- [ ] three";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(3);
	});

	it("replaces bullet markers with bullet widget for regular list items", () => {
		const view = createViewForTest("text\n\n- item one\n- item two");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(2);
		for (const w of widgets) {
			expect(w.value.spec.widget).toBeInstanceOf(BulletWidget);
		}
	});

	it("replaces * and + bullet markers with bullet widget", () => {
		const view = createViewForTest("text\n\n* item one\n+ item two");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(2);
		for (const w of widgets) {
			expect(w.value.spec.widget).toBeInstanceOf(BulletWidget);
		}
	});

	it("does not replace markers for ordered list items", () => {
		const view = createViewForTest("text\n\n1. first\n2. second");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});

	it("keeps bullet decoration when cursor is on line", () => {
		const doc = "text\n\n- item one\n- item two";
		const cursorPos = doc.indexOf("- item one");
		const view = createViewForTest(doc, cursorPos);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(2);
	});

	it("replacement range covers marker and trailing space only", () => {
		const doc = "text\n\n- item one";
		const view = createViewForTest(doc);
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		expect(replaces).toHaveLength(1);
		const dashPos = doc.indexOf("- ");
		// Should replace "- " (marker + space), preserving any indentation before it
		expect(replaces[0].from).toBe(dashPos);
		expect(replaces[0].to).toBe(dashPos + 2);
	});

	it("applies cm-task-checked mark for checked tasks", () => {
		const view = createViewForTest("text\n\n- [x] done task");
		const decos = collectDecorations(buildDecorations(view));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(1);
		expect((marks[0].value.spec as { class: string }).class).toBe("cm-task-checked");
	});

	it("does not apply cm-task-checked mark for unchecked tasks", () => {
		const view = createViewForTest("text\n\n- [ ] pending task");
		const decos = collectDecorations(buildDecorations(view));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(0);
	});

	it("keeps task decoration when cursor is on line", () => {
		const doc = "text\n\n- [ ] task";
		const cursorPos = doc.indexOf("- [ ]");
		const view = createViewForTest(doc, cursorPos);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
	});

	it("first replace range covers ListMark to TaskMarker", () => {
		const doc = "text\n\n- [ ] task";
		const view = createViewForTest(doc);
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		// First replace: ListMark.from to TaskMarker.from
		const listMarkPos = doc.indexOf("- [ ]");
		const taskMarkerPos = doc.indexOf("[ ]");
		expect(replaces[0].from).toBe(listMarkPos);
		expect(replaces[0].to).toBe(taskMarkerPos);
	});

	it("returns empty set for document without lists", () => {
		const view = createViewForTest("hello world\n\nno lists here");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});
});

describe("checkbox toggle", () => {
	it("toggles [ ] to [x]", () => {
		const doc = "- [ ] task";
		const state = createTestState(doc);
		const pos = doc.indexOf("[ ]");
		const tr = state.update({ changes: { from: pos, to: pos + 3, insert: "[x]" } });
		expect(tr.state.doc.toString()).toBe("- [x] task");
	});

	it("toggles [x] to [ ]", () => {
		const doc = "- [x] task";
		const state = createTestState(doc);
		const pos = doc.indexOf("[x]");
		const tr = state.update({ changes: { from: pos, to: pos + 3, insert: "[ ]" } });
		expect(tr.state.doc.toString()).toBe("- [ ] task");
	});

	it("toggles [X] (uppercase) to [ ]", () => {
		const doc = "- [X] task";
		const state = createTestState(doc);
		const pos = doc.indexOf("[X]");
		const tr = state.update({ changes: { from: pos, to: pos + 3, insert: "[ ]" } });
		expect(tr.state.doc.toString()).toBe("- [ ] task");
	});

	it("preserves surrounding text when toggling", () => {
		const doc = "before\n- [ ] task\nafter";
		const state = createTestState(doc);
		const pos = doc.indexOf("[ ]");
		const tr = state.update({ changes: { from: pos, to: pos + 3, insert: "[x]" } });
		expect(tr.state.doc.toString()).toBe("before\n- [x] task\nafter");
	});
});

describe("ensureTaskMarkerSpace", () => {
	it("appends space when task marker has no trailing space", () => {
		const state = createTestState("text\n\n- [ ] abc", undefined, listKeymap);
		// Simulate splitting the line: delete " abc" and insert newline + continuation
		const pos = state.doc.toString().indexOf(" abc");
		const tr = state.update({
			changes: { from: pos, to: pos + 4, insert: "\n- [ ] abc" },
		});
		// Line 3 should be "- [ ] " (with trailing space added by filter)
		expect(tr.state.doc.line(3).text).toBe("- [ ] ");
	});

	it("appends space for checked marker [x]", () => {
		const state = createTestState("- [x] done", undefined, listKeymap);
		const pos = state.doc.toString().indexOf(" done");
		const tr = state.update({
			changes: { from: pos, to: pos + 5, insert: "\n- [ ] done" },
		});
		expect(tr.state.doc.line(1).text).toBe("- [x] ");
	});

	it("does not add space when task marker already has content", () => {
		const state = createTestState("- [ ] abc", undefined, listKeymap);
		const tr = state.update({
			changes: { from: state.doc.length, insert: "d" },
		});
		expect(tr.state.doc.toString()).toBe("- [ ] abcd");
	});
});
