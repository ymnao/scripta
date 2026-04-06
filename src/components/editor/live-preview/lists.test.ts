import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
	BulletWidget,
	buildDecorations,
	CheckboxWidget,
	findMarkerRange,
	listKeymap,
} from "./lists";
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

	it("toDOM() creates a cm-list-marker container with checked checkbox inside", () => {
		const widget = new CheckboxWidget(true, 42);
		const container = widget.toDOM();
		expect(container.tagName).toBe("SPAN");
		expect(container.classList.contains("cm-list-marker")).toBe(true);
		const el = container.querySelector(".cm-task-checkbox") as HTMLElement;
		expect(el).not.toBeNull();
		expect(el.classList.contains("cm-task-checkbox-checked")).toBe(true);
		expect(el.dataset.pos).toBe("42");
		expect(el.getAttribute("role")).toBe("checkbox");
		expect(el.getAttribute("aria-checked")).toBe("true");
		expect(el.getAttribute("aria-label")).toBe("Toggle task");
		const svg = el.querySelector("svg");
		expect(svg).not.toBeNull();
		expect(svg?.classList.contains("cm-task-checkmark")).toBe(true);
	});

	it("toDOM() creates a cm-list-marker container with unchecked checkbox inside", () => {
		const widget = new CheckboxWidget(false, 0);
		const container = widget.toDOM();
		expect(container.tagName).toBe("SPAN");
		expect(container.classList.contains("cm-list-marker")).toBe(true);
		const el = container.querySelector(".cm-task-checkbox") as HTMLElement;
		expect(el).not.toBeNull();
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

	it("toDOM() creates a cm-list-marker container with bullet inside", () => {
		const widget = new BulletWidget();
		const container = widget.toDOM();
		expect(container.tagName).toBe("SPAN");
		expect(container.classList.contains("cm-list-marker")).toBe(true);
		const inner = container.querySelector(".cm-bullet-mark") as HTMLElement;
		expect(inner).not.toBeNull();
		expect(inner.textContent).toBe("•");
	});

	it("ignoreEvent() returns true", () => {
		const widget = new BulletWidget();
		expect(widget.ignoreEvent()).toBe(true);
	});
});

describe("buildDecorations", () => {
	it("creates two replace decorations for a task item", () => {
		const view = createViewForTest("text\n\n- [ ] task");
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		// 1 replace+widget for ListMark through TaskMarker, 1 replace for trailing space
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

	it("does not decorate bullet marker without trailing space", () => {
		// "-" alone at end of line should not become a bullet widget
		const view = createViewForTest("text\n\n-");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(0);
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

	it("replace ranges cover ListMark-TaskMarker and trailing space separately", () => {
		const doc = "text\n\n- [ ] task";
		const view = createViewForTest(doc);
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		const listMarkPos = doc.indexOf("- [ ]");
		// First replace: ListMark through TaskMarker "- [ ]" = 5 chars
		expect(replaces[0].from).toBe(listMarkPos);
		expect(replaces[0].to).toBe(listMarkPos + 5);
		// Second replace: trailing space
		expect(replaces[1].from).toBe(listMarkPos + 5);
		expect(replaces[1].to).toBe(listMarkPos + 6);
	});

	it("both bullet and checkbox widgets use cm-list-marker container", () => {
		const bulletWidget = new BulletWidget();
		const checkboxWidget = new CheckboxWidget(false, 0);
		const bulletContainer = bulletWidget.toDOM();
		const checkboxContainer = checkboxWidget.toDOM();
		expect(bulletContainer.classList.contains("cm-list-marker")).toBe(true);
		expect(checkboxContainer.classList.contains("cm-list-marker")).toBe(true);
	});

	it("decorates nested bullet list items", () => {
		const doc = "text\n\n- parent\n  - child";
		const view = createViewForTest(doc);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(2);
		for (const w of widgets) {
			expect(w.value.spec.widget).toBeInstanceOf(BulletWidget);
		}
	});

	it("decorates nested task list items", () => {
		const doc = "text\n\n- [ ] parent\n  - [ ] child";
		const view = createViewForTest(doc);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(2);
		for (const w of widgets) {
			expect(w.value.spec.widget).toBeInstanceOf(CheckboxWidget);
		}
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

	it("moves cursor past appended space when cursor is inside marker (closeBrackets)", () => {
		// closeBrackets auto-inserts "]" when "[" is typed, leaving cursor before "]".
		// After typing space: "- [ ]" with cursor at position 4 (before "]").
		const state = createTestState("- []", undefined, listKeymap);
		const tr = state.update({
			changes: { from: 3, insert: " " },
			selection: EditorSelection.cursor(4),
		});
		expect(tr.state.doc.toString()).toBe("- [ ] ");
		expect(tr.state.selection.main.head).toBe(6);
	});

	it("does not move cursor when cursor is after marker (Enter split)", () => {
		const state = createTestState("- [ ] abc", undefined, listKeymap);
		const pos = state.doc.toString().indexOf(" abc");
		const tr = state.update({
			changes: { from: pos, to: pos + 4, insert: "\n- [ ] abc" },
		});
		// Space should be appended but cursor should NOT be moved inside line 1's marker
		expect(tr.state.doc.line(1).text).toBe("- [ ] ");
		// Cursor maps to end of deleted range = line 1 boundary, not inside marker
		expect(tr.state.selection.main.head).toBeGreaterThanOrEqual(tr.state.doc.line(1).to);
	});
});

describe("convertBracketToTask", () => {
	it("converts `[] ` to `- [ ] `", () => {
		const state = createTestState("[]", undefined, listKeymap);
		// Type a space after "[]" → "[] "
		const tr = state.update({
			changes: { from: 2, insert: " " },
			selection: EditorSelection.cursor(3),
		});
		expect(tr.state.doc.toString()).toBe("- [ ] ");
	});

	it("converts indented `  [] ` to `  - [ ] `", () => {
		const state = createTestState("  []", undefined, listKeymap);
		const tr = state.update({
			changes: { from: 4, insert: " " },
			selection: EditorSelection.cursor(5),
		});
		expect(tr.state.doc.toString()).toBe("  - [ ] ");
	});

	it("does not convert `[]` mid-line", () => {
		const state = createTestState("text []", undefined, listKeymap);
		const tr = state.update({
			changes: { from: 7, insert: " " },
			selection: EditorSelection.cursor(8),
		});
		expect(tr.state.doc.toString()).toBe("text [] ");
	});

	it("does not convert `[x] `", () => {
		const state = createTestState("[x]", undefined, listKeymap);
		const tr = state.update({
			changes: { from: 3, insert: " " },
			selection: EditorSelection.cursor(4),
		});
		expect(tr.state.doc.toString()).toBe("[x] ");
	});

	it("moves cursor to end of `- [ ] ` after conversion", () => {
		const state = createTestState("[]", undefined, listKeymap);
		const tr = state.update({
			changes: { from: 2, insert: " " },
			selection: EditorSelection.cursor(3),
		});
		// "- [ ] " has length 6, cursor should be at 6
		expect(tr.state.selection.main.head).toBe(6);
	});

	it("moves cursor correctly for indented conversion", () => {
		const state = createTestState("\t[]", undefined, listKeymap);
		const tr = state.update({
			changes: { from: 3, insert: " " },
			selection: EditorSelection.cursor(4),
		});
		expect(tr.state.doc.toString()).toBe("\t- [ ] ");
		// "\t" (1) + "- [ ] " (6) = 7
		expect(tr.state.selection.main.head).toBe(7);
	});

	it("converts `[ ]` (space inside brackets) to `- [ ] `", () => {
		const state = createTestState("[]", undefined, listKeymap);
		// Type a space inside [] → "[ ]" with cursor at position 2
		const tr = state.update({
			changes: { from: 1, insert: " " },
			selection: EditorSelection.cursor(2),
		});
		expect(tr.state.doc.toString()).toBe("- [ ] ");
	});

	it("converts indented `  [ ]` to `  - [ ] `", () => {
		const state = createTestState("  []", undefined, listKeymap);
		const tr = state.update({
			changes: { from: 3, insert: " " },
			selection: EditorSelection.cursor(4),
		});
		expect(tr.state.doc.toString()).toBe("  - [ ] ");
	});

	it("does not convert `[ ]` mid-line", () => {
		const state = createTestState("text []", undefined, listKeymap);
		const tr = state.update({
			changes: { from: 6, insert: " " },
			selection: EditorSelection.cursor(7),
		});
		expect(tr.state.doc.toString()).toBe("text [ ]");
	});

	it("moves cursor to end of `- [ ] ` after `[ ]` conversion", () => {
		const state = createTestState("[]", undefined, listKeymap);
		const tr = state.update({
			changes: { from: 1, insert: " " },
			selection: EditorSelection.cursor(2),
		});
		expect(tr.state.selection.main.head).toBe(6);
	});
});

describe("findMarkerRange", () => {
	it("detects bullet marker range", () => {
		const state = createTestState("- item");
		const line = state.doc.line(1);
		const range = findMarkerRange(state, line);
		expect(range).toEqual({ from: 0, to: 2 });
	});

	it("detects task marker range", () => {
		const state = createTestState("- [ ] task");
		const line = state.doc.line(1);
		const range = findMarkerRange(state, line);
		expect(range).toEqual({ from: 0, to: 6 });
	});

	it("detects indented bullet marker range", () => {
		const state = createTestState("  - nested");
		const line = state.doc.line(1);
		const range = findMarkerRange(state, line);
		expect(range).toEqual({ from: 0, to: 4 });
	});

	it("detects indented task marker range", () => {
		const state = createTestState("  - [x] done");
		const line = state.doc.line(1);
		const range = findMarkerRange(state, line);
		expect(range).toEqual({ from: 0, to: 8 });
	});

	it("returns null for plain text", () => {
		const state = createTestState("just text");
		const line = state.doc.line(1);
		expect(findMarkerRange(state, line)).toBeNull();
	});

	it("returns null for ordered list", () => {
		const state = createTestState("1. ordered");
		const line = state.doc.line(1);
		expect(findMarkerRange(state, line)).toBeNull();
	});

	it("handles * and + markers", () => {
		const stateAsterisk = createTestState("* item");
		expect(findMarkerRange(stateAsterisk, stateAsterisk.doc.line(1))).toEqual({ from: 0, to: 2 });

		const statePlus = createTestState("+ item");
		expect(findMarkerRange(statePlus, statePlus.doc.line(1))).toEqual({ from: 0, to: 2 });
	});

	it("returns correct range for line not at document start", () => {
		const state = createTestState("hello\n- item");
		const line = state.doc.line(2);
		expect(findMarkerRange(state, line)).toEqual({ from: 6, to: 8 });
	});

	it("returns null for bullet marker inside fenced code block", () => {
		const doc = "text\n\n```\n- item\n```";
		const state = createTestState(doc);
		ensureSyntaxTree(state, state.doc.length, 5000);
		const line = state.doc.line(4); // "- item" inside code block
		expect(findMarkerRange(state, line)).toBeNull();
	});

	it("returns null for task marker inside fenced code block", () => {
		const doc = "text\n\n```\n- [ ] task\n```";
		const state = createTestState(doc);
		ensureSyntaxTree(state, state.doc.length, 5000);
		const line = state.doc.line(4); // "- [ ] task" inside code block
		expect(findMarkerRange(state, line)).toBeNull();
	});
});

describe("ArrowLeft keymap", () => {
	it("moves cursor to previous line end from marker area", () => {
		// Cursor at content start of bullet list (position 8 = after "- ")
		const doc = "hello\n- item";
		const contentStart = doc.indexOf("item");
		const state = createTestState(doc, contentStart, listKeymap);
		// ArrowLeft handler checks head > range.from && head <= range.to
		// range = { from: 6, to: 8 }, head = 8 → should jump to line 1 end (5)
		const line = state.doc.lineAt(contentStart);
		const range = findMarkerRange(state, line);
		expect(range).not.toBeNull();
		expect(contentStart).toBe(range?.to);
		// Verify handler would move to previous line end
		const prevLine = state.doc.line(line.number - 1);
		expect(prevLine.to).toBe(5);
	});

	it("does not activate when cursor is in content area", () => {
		const doc = "hello\n- item";
		const state = createTestState(doc, doc.indexOf("tem"), listKeymap);
		const line = state.doc.lineAt(doc.indexOf("tem"));
		const range = findMarkerRange(state, line);
		// Cursor at position 10 ("tem"), range.to = 8
		// head > range.to → handler returns false
		expect(range).not.toBeNull();
		expect(doc.indexOf("tem")).toBeGreaterThan(range?.to as number);
	});

	it("does not activate on first line of document", () => {
		const state = createTestState("- item", 2, listKeymap);
		const line = state.doc.lineAt(2);
		const range = findMarkerRange(state, line);
		expect(range).not.toBeNull();
		// line.number === 1, so handler returns false (no previous line)
		expect(line.number).toBe(1);
	});

	it("does not activate for non-list lines", () => {
		const state = createTestState("hello\nworld", 6, listKeymap);
		const line = state.doc.lineAt(6);
		expect(findMarkerRange(state, line)).toBeNull();
	});
});

describe("ArrowRight keymap", () => {
	it("skips marker when moving from line end to next list line", () => {
		const doc = "hello\n- item";
		const lineEndPos = 5; // end of "hello"
		const state = createTestState(doc, lineEndPos, listKeymap);
		const line = state.doc.lineAt(lineEndPos);
		// head === line.to (5) and next line has a marker
		expect(line.to).toBe(lineEndPos);
		const nextLine = state.doc.line(line.number + 1);
		const range = findMarkerRange(state, nextLine);
		expect(range).not.toBeNull();
		// Handler would move cursor to range.to = 8 (content start)
		expect(range?.to).toBe(8);
	});

	it("skips marker when cursor is inside marker area", () => {
		const doc = "- item";
		const state = createTestState(doc, 0, listKeymap);
		const line = state.doc.lineAt(0);
		const range = findMarkerRange(state, line);
		expect(range).not.toBeNull();
		// head (0) >= range.from (0) && head (0) < range.to (2) → jump to 2
		expect(range?.to).toBe(2);
	});

	it("does not activate when cursor is in content area", () => {
		const doc = "- item";
		const state = createTestState(doc, 3, listKeymap);
		const line = state.doc.lineAt(3);
		const range = findMarkerRange(state, line);
		expect(range).not.toBeNull();
		// head (3) >= range.from but head (3) >= range.to (2) → not inside marker
		expect(3).toBeGreaterThanOrEqual(range?.to as number);
	});

	it("does not activate at end of last line", () => {
		const doc = "- item";
		const state = createTestState(doc, 6, listKeymap);
		const line = state.doc.lineAt(6);
		// head === line.to but line.number === state.doc.lines → no next line
		expect(line.number).toBe(state.doc.lines);
	});

	it("does not activate when next line is not a list item", () => {
		const doc = "hello\nworld";
		const state = createTestState(doc, 5, listKeymap);
		const line = state.doc.lineAt(5);
		const nextLine = state.doc.line(line.number + 1);
		expect(findMarkerRange(state, nextLine)).toBeNull();
	});
});
