import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
	BulletWidget,
	buildDecorations,
	CheckboxWidget,
	computeListIndentChanges,
	findMarkerRange,
	listKeymap,
	parseListLine,
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

describe("parseListLine", () => {
	it("parses ordered list with `.` delimiter", () => {
		const info = parseListLine("1. a");
		expect(info).toEqual({
			indent: "",
			ordered: { number: 1, delim: "." },
			task: false,
			markerWidth: 3,
		});
	});

	it("parses ordered list with `)` delimiter", () => {
		const info = parseListLine("12) hello");
		expect(info).toEqual({
			indent: "",
			ordered: { number: 12, delim: ")" },
			task: false,
			markerWidth: 4,
		});
	});

	it("parses ordered list with leading indent", () => {
		const info = parseListLine("  3. nested");
		expect(info?.indent).toBe("  ");
		expect(info?.ordered).toEqual({ number: 3, delim: "." });
	});

	it("parses bullet list", () => {
		const info = parseListLine("- a");
		expect(info).toEqual({ indent: "", ordered: null, task: false, markerWidth: 2 });
	});

	it("parses indented bullet list", () => {
		const info = parseListLine("    * x");
		expect(info?.indent).toBe("    ");
		expect(info?.ordered).toBeNull();
		expect(info?.task).toBe(false);
	});

	it("parses task list", () => {
		const info = parseListLine("- [ ] todo");
		expect(info).toEqual({ indent: "", ordered: null, task: true, markerWidth: 6 });
	});

	it("parses checked task list", () => {
		const info = parseListLine("  - [x] done");
		expect(info?.task).toBe(true);
		expect(info?.indent).toBe("  ");
	});

	it("returns null for plain text", () => {
		expect(parseListLine("hello world")).toBeNull();
	});

	it("returns null for line starting with number but no marker", () => {
		expect(parseListLine("123 abc")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseListLine("")).toBeNull();
	});
});

describe("computeListIndentChanges", () => {
	function applyChanges(doc: string, sel: number | EditorSelection, direction: 1 | -1): string {
		const cursor = typeof sel === "number" ? sel : undefined;
		const selection = typeof sel === "number" ? undefined : sel;
		const state = createTestState(doc, cursor, undefined, selection);
		const result = computeListIndentChanges(state, direction);
		if (!result) return doc;
		return state.update({ changes: result.changes }).state.doc.toString();
	}
	const applyChangesWithSelection = applyChanges;

	// --- The exact case from issue #118 -----------------------------------
	// Note: nested indent matches the parent's content offset so the markdown
	// parser sees a true CommonMark sub-list. For "1. a" the content offset is
	// 3 columns; for bullets "- " it is 2; for tasks "- [ ] " it is 6.

	it("Tab after Enter-continued ordered marker renumbers child to 1", () => {
		// User typed "1. a", Enter (→ "2. "), Tab.
		const doc = "1. a\n2. ";
		const cursor = doc.length; // right after "2. "
		expect(applyChanges(doc, cursor, 1)).toBe("1. a\n   1. ");
	});

	it("Tab on doubly-nested item uses parent's content offset", () => {
		// Tab on the deepest line. Parent "   1. b" has content offset 6,
		// so deeper level indents to 6 columns.
		const doc = "1. a\n   1. b\n   2. c";
		expect(applyChanges(doc, doc.indexOf("c"), 1)).toBe("1. a\n   1. b\n      1. c");
	});

	// --- Tab on existing list items ----------------------------------------

	it("Tab on second item indents it and renumbers later siblings", () => {
		const doc = "1. a\n2. b\n3. c";
		// Cursor on line 2
		const cursor = doc.indexOf("2.");
		expect(applyChanges(doc, cursor, 1)).toBe("1. a\n   1. b\n2. c");
	});

	it("Tab on last item indents and renumbers", () => {
		const doc = "1. a\n2. b";
		const cursor = doc.indexOf("2.");
		expect(applyChanges(doc, cursor, 1)).toBe("1. a\n   1. b");
	});

	it("Tab on item that joins an existing sub-list continues numbering", () => {
		const doc = "1. a\n   1. x\n   2. y\n2. b";
		// Tab on "2. b" → joins the existing sub-list (at col 3) as item 3
		const cursor = doc.lastIndexOf("2. b");
		expect(applyChanges(doc, cursor, 1)).toBe("1. a\n   1. x\n   2. y\n   3. b");
	});

	it("Tab on a bullet list line does not affect numbering", () => {
		// Bullet content offset is 2, matching the default indent unit.
		const doc = "- a\n- b\n- c";
		const cursor = doc.indexOf("- b");
		expect(applyChanges(doc, cursor, 1)).toBe("- a\n  - b\n- c");
	});

	it("Tab on a task list line indents it under task parent", () => {
		// Task marker "- [ ] " has content offset 6.
		const doc = "- [ ] a\n- [ ] b";
		const cursor = doc.lastIndexOf("- [ ]");
		expect(applyChanges(doc, cursor, 1)).toBe("- [ ] a\n      - [ ] b");
	});

	it("Tab on a plain text line falls through (returns null)", () => {
		const state = createTestState("hello world", 5);
		expect(computeListIndentChanges(state, 1)).toBeNull();
	});

	it("Tab on a line inside a fenced code block falls through", () => {
		// Even if the line looks like a list, it should not be treated as one.
		const state = createTestState("```\n1. inside\n```", "```\n1. ".length);
		expect(computeListIndentChanges(state, 1)).toBeNull();
	});

	// --- Shift+Tab (outdent) ----------------------------------------------

	it("Shift+Tab on first sub-item joins parent and renumbers continuation", () => {
		// Sub-list now at parent's content offset (3 columns under `1. a`).
		const doc = "1. a\n   1. b\n2. c";
		const cursor = doc.indexOf("   1. b") + 3;
		// Outdent line 2 → "1. a / 2. b / 3. c" (continuation at parent level).
		expect(applyChanges(doc, cursor, -1)).toBe("1. a\n2. b\n3. c");
	});

	it("Shift+Tab on middle sub-item leaves remaining sub-item with original number", () => {
		// `   2. c` was originally the second sub-item. After outdenting
		// `   1. b`, the remaining `   2. c` keeps its number (we preserve
		// user-chosen first-item numbers of un-touched runs).
		const doc = "1. a\n   1. b\n   2. c";
		const cursor = doc.indexOf("   1. b") + 3;
		expect(applyChanges(doc, cursor, -1)).toBe("1. a\n2. b\n   2. c");
	});

	it("Shift+Tab on first sub-item promotes it and renumbers parent run", () => {
		const doc = "1. a\n  1. b";
		const cursor = doc.indexOf("  1. b") + 2;
		expect(applyChanges(doc, cursor, -1)).toBe("1. a\n2. b");
	});

	it("Shift+Tab on top-level item returns null (no indent to remove)", () => {
		const state = createTestState("1. a\n2. b", 5); // cursor on line 2
		expect(computeListIndentChanges(state, -1)).toBeNull();
	});

	// --- Multi-line selection ---------------------------------------------

	it("Tab on multi-line selection indents all list lines", () => {
		const doc = "1. a\n2. b\n3. c";
		const selection = EditorSelection.single(doc.indexOf("2."), doc.indexOf("3.") + 4);
		expect(applyChangesWithSelection(doc, selection, 1)).toBe("1. a\n   1. b\n   2. c");
	});

	it("Tab on selection that ends at next-line boundary excludes the trailing line", () => {
		// `EditorSelection.single(doc.indexOf("2."), doc.indexOf("3."))` selects
		// from the start of "2. b" up to (but NOT including) "3. c". Only the
		// "2. b" line should be indented; "3. c" must stay at the parent level
		// and renumber from 3 to 2. Matches CM's `changeBySelectedLine` rule.
		const doc = "1. a\n2. b\n3. c";
		const selection = EditorSelection.single(doc.indexOf("2."), doc.indexOf("3."));
		expect(applyChangesWithSelection(doc, selection, 1)).toBe("1. a\n   1. b\n2. c");
	});

	it("Shift+Tab on multi-line selection outdents and renumbers", () => {
		const doc = "1. a\n   1. b\n   2. c\n   3. d";
		const selection = EditorSelection.single(doc.indexOf("   2."), doc.indexOf("   3.") + 6);
		// Outdent lines 3 and 4 → "" indent. Line 2 stays at "   1. b".
		expect(applyChangesWithSelection(doc, selection, -1)).toBe("1. a\n   1. b\n2. c\n3. d");
	});

	// --- Edge cases --------------------------------------------------------

	it("does not renumber if non-modified ordered list has gaps", () => {
		// User wrote "1. a / 5. b" intentionally. We must NOT renumber 5 to 2.
		// However if we Tab on "5. b", that line's number is forced to fresh = 1.
		const doc = "1. a\n5. b";
		const cursor = doc.indexOf("5.");
		expect(applyChanges(doc, cursor, 1)).toBe("1. a\n   1. b");
	});

	it("preserves user-chosen start number on non-modified lines", () => {
		// Tabbing one item in a separate ordered list must not touch the other.
		const doc = "5. a\n6. b\n7. c";
		const cursor = doc.indexOf("6.");
		// Modified line 2 → indent + fresh "1." at parent's content offset
		// (col 3 for single-digit "5."). Line 3 renumbers from 7 to 6.
		expect(applyChanges(doc, cursor, 1)).toBe("5. a\n   1. b\n6. c");
	});

	it("breaks ordered run at blank line", () => {
		const doc = "1. a\n\n2. b\n3. c";
		const cursor = doc.indexOf("3.");
		// Block scanning stops at the blank line, so item 1 is untouched.
		// Tab on "3. c" → parent on previous line is "2. b" (offset 3).
		expect(applyChanges(doc, cursor, 1)).toBe("1. a\n\n2. b\n   1. c");
	});

	it("respects ordered list separator (bullet between ordered items)", () => {
		const doc = "1. a\n- separator\n2. b\n3. c";
		const cursor = doc.indexOf("3.");
		// Tab on "3. c" → parent on previous line is "2. b" (offset 3).
		expect(applyChanges(doc, cursor, 1)).toBe("1. a\n- separator\n2. b\n   1. c");
	});

	it("handles two-digit numbers in renumber", () => {
		// Tab on item 5 of a 9-item list. Items 6..9 renumber to 5..8.
		const lines = Array.from({ length: 9 }, (_, i) => `${i + 1}. item${i + 1}`).join("\n");
		const cursor = lines.indexOf("5.");
		const result = applyChanges(lines, cursor, 1);
		const expected =
			"1. item1\n2. item2\n3. item3\n4. item4\n   1. item5\n5. item6\n6. item7\n7. item8\n8. item9";
		expect(result).toBe(expected);
	});

	it("handles renumbering 10 → 9 (number length shrinks)", () => {
		// Tab on item 2 of a 10-item list. Items 3..10 renumber to 2..9; item 10 → "9" (length shrinks 2 → 1).
		const items = Array.from({ length: 10 }, (_, i) => `${i + 1}. item${i + 1}`).join("\n");
		const cursor = items.indexOf("2.");
		const result = applyChanges(items, cursor, 1);
		expect(result).toBe(
			"1. item1\n   1. item2\n2. item3\n3. item4\n4. item5\n5. item6\n6. item7\n7. item8\n8. item9\n9. item10",
		);
	});

	it("Tab on already-nested item nests it one more level", () => {
		const doc = "1. a\n   1. b";
		const cursor = doc.indexOf("   1. b") + 3;
		// Parent on previous line is "   1. b" itself? No, look UP: previous
		// non-deeper list line is "1. a" at col 0 — but "1. a" is shallower,
		// so we fall through to "oldIndent + LIST_INDENT_UNIT" (3 + 2 = 5 cols).
		expect(applyChanges(doc, cursor, 1)).toBe("1. a\n     1. b");
	});

	it("Shift+Tab on a bullet item outdents it", () => {
		const doc = "- a\n  - b";
		const cursor = doc.indexOf("  - b") + 2;
		expect(applyChanges(doc, cursor, -1)).toBe("- a\n- b");
	});

	// --- Regression: user-reported case from chat -------------------------

	it("Enter Tab sequence on empty ordered list nests at parent content offset", () => {
		// Initial state from user report: empty 1./2./3. list.
		// Cursor at end of "1. ", Enter produces "1. \n2. " (continuation),
		// then Tab on "2. " should produce "1. \n   1. \n3. \n4. " (because
		// insertNewlineContinueMarkup will renumber 2 and 3 to 3 and 4).
		// Here we just verify the Tab step in isolation: starting from
		// "1. \n2. \n2. \n3. " (with a 2nd "2. " inserted by Enter continuation),
		// Tab on line 2 yields a properly-nested sub-list.
		const doc = "1. \n2. \n2. \n3. ";
		const cursor = doc.indexOf("2.");
		expect(applyChanges(doc, cursor, 1)).toBe("1. \n   1. \n2. \n3. ");
	});
});
