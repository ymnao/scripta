import { describe, expect, it } from "vitest";
import { CheckboxWidget, buildDecorations } from "./lists";
import {
	collectDecorations,
	createTestState,
	createViewForTest,
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

	it("toDOM() creates a checkbox input with correct attributes", () => {
		const widget = new CheckboxWidget(true, 42);
		const el = widget.toDOM() as HTMLInputElement;
		expect(el.tagName).toBe("INPUT");
		expect(el.type).toBe("checkbox");
		expect(el.className).toBe("cm-task-checkbox");
		expect(el.checked).toBe(true);
		expect(el.dataset.pos).toBe("42");
		expect(el.getAttribute("aria-label")).toBe("Toggle task");
	});

	it("toDOM() creates unchecked checkbox", () => {
		const widget = new CheckboxWidget(false, 0);
		const el = widget.toDOM() as HTMLInputElement;
		expect(el.checked).toBe(false);
	});

	it("ignoreEvent() returns false", () => {
		const widget = new CheckboxWidget(false, 0);
		expect(widget.ignoreEvent()).toBe(false);
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

	it("does not create decorations for regular list items", () => {
		const view = createViewForTest("- item one\n- item two");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});

	it("skips task on cursor line", () => {
		const doc = "text\n\n- [ ] task";
		const cursorPos = doc.indexOf("- [ ]");
		const view = createViewForTest(doc, cursorPos);
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});

	it("only skips the task where cursor is positioned", () => {
		const doc = "- [ ] one\n- [ ] two";
		// Cursor on first task (pos 0)
		const view = createViewForTest(doc, 0);
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
