import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
	insertHorizontalRule,
	toggleBold,
	toggleCheckState,
	toggleCheckbox,
	toggleHeading,
	toggleItalic,
	toggleList,
	toggleStrikethrough,
} from "./formatting-commands";

function createView(doc: string, from: number, to?: number): EditorView {
	const state = EditorState.create({
		doc,
		selection: EditorSelection.create([EditorSelection.range(from, to ?? from)]),
	});
	return new EditorView({ state });
}

function getDoc(view: EditorView): string {
	return view.state.doc.toString();
}

describe("toggleBold", () => {
	it("wraps selection with **", () => {
		const view = createView("hello world", 6, 11);
		toggleBold(view);
		expect(getDoc(view)).toBe("hello **world**");
	});

	it("unwraps selection already wrapped with **", () => {
		const view = createView("hello **world**", 6, 15);
		toggleBold(view);
		expect(getDoc(view)).toBe("hello world");
	});

	it("wraps empty selection (inserts markers)", () => {
		const view = createView("hello", 5, 5);
		toggleBold(view);
		expect(getDoc(view)).toBe("hello****");
	});
});

describe("toggleItalic", () => {
	it("wraps selection with *", () => {
		const view = createView("hello world", 6, 11);
		toggleItalic(view);
		expect(getDoc(view)).toBe("hello *world*");
	});

	it("unwraps selection already wrapped with *", () => {
		const view = createView("hello *world*", 6, 13);
		toggleItalic(view);
		expect(getDoc(view)).toBe("hello world");
	});

	it("does not unwrap bold markers when toggling italic", () => {
		const view = createView("hello **bold**", 6, 14);
		toggleItalic(view);
		expect(getDoc(view)).toBe("hello ***bold***");
	});

	it("does not unwrap bold markers with leading **", () => {
		const view = createView("**bold**", 0, 8);
		toggleItalic(view);
		expect(getDoc(view)).toBe("***bold***");
	});
});

describe("toggleStrikethrough", () => {
	it("wraps selection with ~~", () => {
		const view = createView("hello world", 6, 11);
		toggleStrikethrough(view);
		expect(getDoc(view)).toBe("hello ~~world~~");
	});

	it("unwraps selection already wrapped with ~~", () => {
		const view = createView("hello ~~world~~", 6, 15);
		toggleStrikethrough(view);
		expect(getDoc(view)).toBe("hello world");
	});
});

describe("toggleHeading", () => {
	it("adds heading prefix to line", () => {
		const view = createView("hello", 0);
		toggleHeading(1)(view);
		expect(getDoc(view)).toBe("# hello");
	});

	it("removes heading when same level", () => {
		const view = createView("# hello", 2);
		toggleHeading(1)(view);
		expect(getDoc(view)).toBe("hello");
	});

	it("changes heading level", () => {
		const view = createView("# hello", 2);
		toggleHeading(2)(view);
		expect(getDoc(view)).toBe("## hello");
	});

	it("adds heading level 3", () => {
		const view = createView("hello", 0);
		toggleHeading(3)(view);
		expect(getDoc(view)).toBe("### hello");
	});

	it("changes from level 3 to level 1", () => {
		const view = createView("### hello", 4);
		toggleHeading(1)(view);
		expect(getDoc(view)).toBe("# hello");
	});
});

describe("toggleList", () => {
	it("adds list marker to plain line", () => {
		const view = createView("hello", 0);
		toggleList(view);
		expect(getDoc(view)).toBe("- hello");
	});

	it("removes list marker from list item", () => {
		const view = createView("- hello", 2);
		toggleList(view);
		expect(getDoc(view)).toBe("hello");
	});

	it("removes list marker and checkbox from task item", () => {
		const view = createView("- [ ] hello", 6);
		toggleList(view);
		expect(getDoc(view)).toBe("hello");
	});

	it("removes checked task marker", () => {
		const view = createView("- [x] hello", 6);
		toggleList(view);
		expect(getDoc(view)).toBe("hello");
	});

	it("preserves leading whitespace when adding", () => {
		const view = createView("  hello", 2);
		toggleList(view);
		expect(getDoc(view)).toBe("  - hello");
	});

	it("preserves leading whitespace when removing", () => {
		const view = createView("  - hello", 4);
		toggleList(view);
		expect(getDoc(view)).toBe("  hello");
	});
});

describe("toggleCheckbox", () => {
	it("adds checkbox to plain line", () => {
		const view = createView("hello", 0);
		toggleCheckbox(view);
		expect(getDoc(view)).toBe("- [ ] hello");
	});

	it("removes checkbox from unchecked task", () => {
		const view = createView("- [ ] hello", 6);
		toggleCheckbox(view);
		expect(getDoc(view)).toBe("hello");
	});

	it("removes checkbox from checked task", () => {
		const view = createView("- [x] hello", 6);
		toggleCheckbox(view);
		expect(getDoc(view)).toBe("hello");
	});

	it("replaces list marker with checkbox", () => {
		const view = createView("- hello", 2);
		toggleCheckbox(view);
		expect(getDoc(view)).toBe("- [ ] hello");
	});

	it("preserves indentation when adding to plain line", () => {
		const view = createView("  hello", 2);
		toggleCheckbox(view);
		expect(getDoc(view)).toBe("  - [ ] hello");
	});
});

describe("toggleCheckState", () => {
	it("checks unchecked checkbox", () => {
		const view = createView("- [ ] hello", 6);
		toggleCheckState(view);
		expect(getDoc(view)).toBe("- [x] hello");
	});

	it("unchecks checked checkbox", () => {
		const view = createView("- [x] hello", 6);
		toggleCheckState(view);
		expect(getDoc(view)).toBe("- [ ] hello");
	});

	it("returns false on non-checkbox line", () => {
		const view = createView("- hello", 2);
		const result = toggleCheckState(view);
		expect(result).toBe(false);
		expect(getDoc(view)).toBe("- hello");
	});

	it("returns false on plain line", () => {
		const view = createView("hello", 0);
		const result = toggleCheckState(view);
		expect(result).toBe(false);
		expect(getDoc(view)).toBe("hello");
	});
});

describe("insertHorizontalRule", () => {
	it("inserts horizontal rule on empty line", () => {
		const view = createView("", 0);
		insertHorizontalRule(view);
		expect(getDoc(view)).toBe("---");
	});

	it("inserts horizontal rule after non-empty line", () => {
		const view = createView("hello", 3);
		insertHorizontalRule(view);
		expect(getDoc(view)).toBe("hello\n---");
	});
});
