import { describe, expect, it, vi } from "vitest";
import { collectDecorations, createViewForTest, markDecorations } from "./test-helper";
import { buildDecorations, buildFileMap, parseWikilink } from "./wikilinks";

vi.mock("../../../stores/workspace", () => ({
	useWorkspaceStore: {
		getState: () => ({
			workspacePath: "/workspace",
		}),
	},
}));

vi.mock("../../../lib/commands", () => ({
	createFile: vi.fn(),
	searchFilenames: vi.fn(() => Promise.resolve([])),
}));

describe("parseWikilink", () => {
	it("returns page and display as the same for simple links", () => {
		expect(parseWikilink("page")).toEqual({ page: "page", display: "page" });
	});

	it("splits page and display on pipe", () => {
		expect(parseWikilink("page|text")).toEqual({ page: "page", display: "text" });
	});

	it("falls back to page name when display is empty", () => {
		expect(parseWikilink("page|")).toEqual({ page: "page", display: "page" });
	});

	it("handles pipe in display text", () => {
		expect(parseWikilink("page|a|b")).toEqual({ page: "page", display: "a|b" });
	});
});

describe("buildFileMap", () => {
	it("maps basename without .md to full path", () => {
		const map = buildFileMap(["/workspace/note.md", "/workspace/todo.md"]);
		expect(map.get("note")).toBe("/workspace/note.md");
		expect(map.get("todo")).toBe("/workspace/todo.md");
	});

	it("uses first occurrence for duplicate basenames", () => {
		const map = buildFileMap(["/workspace/a/note.md", "/workspace/b/note.md"]);
		expect(map.get("note")).toBe("/workspace/a/note.md");
	});

	it("normalizes Unicode to NFC for consistent lookup", () => {
		// NFD form: か(U+304B) + combining dakuten(U+3099) = が
		const nfdPath = "/workspace/\u304B\u3099.md";
		const map = buildFileMap([nfdPath]);
		// NFC lookup: が(U+304C)
		expect(map.get("\u304C")).toBe(nfdPath);
	});

	it("handles kanji file names", () => {
		const map = buildFileMap(["/workspace/日記.md", "/workspace/メモ.md"]);
		expect(map.get("日記")).toBe("/workspace/日記.md");
		expect(map.get("メモ")).toBe("/workspace/メモ.md");
	});
});

describe("buildDecorations", () => {
	const fileMap = buildFileMap(["/workspace/note.md", "/workspace/todo.md"]);

	it("detects basic [[page]] wikilink", () => {
		const view = createViewForTest("text\n\nHello [[note]] world", 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(1);
		expect((marks[0].value.spec as { class: string }).class).toBe("cm-wikilink");
		const attrs = (marks[0].value.spec as { attributes: Record<string, string> }).attributes;
		expect(attrs["data-wikilink-path"]).toBe("/workspace/note.md");
		expect(attrs["data-wikilink-exists"]).toBe("1");
	});

	it("hides [[ and ]] brackets", () => {
		const view = createViewForTest("text\n\nHello [[note]] world", 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		// 2 replaces ([[ and ]]) + 1 mark (content) = 3 total
		expect(decos).toHaveLength(3);
		expect(markDecorations(decos)).toHaveLength(1);
	});

	it("detects alias [[page|text]] wikilink", () => {
		const view = createViewForTest("text\n\n[[note|My Note]]", 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(1);
		// Display text should be marked
		const doc = view.state.doc;
		const markText = doc.sliceString(marks[0].from, marks[0].to);
		expect(markText).toBe("My Note");
	});

	it("hides page| portion in alias wikilinks", () => {
		const view = createViewForTest("text\n\n[[note|My Note]]", 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		// 3 replaces ([[ , note| , ]]) + 1 mark (display text) = 4 total
		expect(decos).toHaveLength(4);
		expect(markDecorations(decos)).toHaveLength(1);
	});

	it("treats [[page|]] as non-alias and shows page name", () => {
		const view = createViewForTest("text\n\n[[note|]]", 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(1);
		// Display text should be "note" (the page name), not "note|"
		const doc = view.state.doc;
		const markText = doc.sliceString(marks[0].from, marks[0].to);
		expect(markText).toBe("note");
		// 3 replaces ([[ , | , ]]) + 1 mark = 4 total
		expect(decos).toHaveLength(4);
		const attrs = (marks[0].value.spec as { attributes: Record<string, string> }).attributes;
		expect(attrs["data-wikilink-exists"]).toBe("1");
	});

	it("marks non-existing files with exists=false", () => {
		const view = createViewForTest("text\n\n[[nonexistent]]", 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(1);
		expect((marks[0].value.spec as { class: string }).class).toBe(
			"cm-wikilink cm-wikilink-missing",
		);
		const attrs = (marks[0].value.spec as { attributes: Record<string, string> }).attributes;
		expect(attrs["data-wikilink-exists"]).toBe("0");
	});

	it("excludes wikilinks inside fenced code blocks", () => {
		const doc = "text\n\n```\n[[note]]\n```";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		expect(markDecorations(decos)).toHaveLength(0);
	});

	it("excludes wikilinks inside inline code", () => {
		const doc = "text\n\n`[[note]]` here";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		expect(markDecorations(decos)).toHaveLength(0);
	});

	it("skips wikilinks on cursor line when focused", () => {
		const doc = "text\n\nHello [[note]] world";
		const cursorPos = doc.indexOf("[[note]]");
		const view = createViewForTest(doc, cursorPos, undefined, true);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		expect(markDecorations(decos)).toHaveLength(0);
	});

	it("does not skip wikilinks on cursor line when unfocused", () => {
		const doc = "text\n\nHello [[note]] world";
		const cursorPos = doc.indexOf("[[note]]");
		const view = createViewForTest(doc, cursorPos, undefined, false);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		expect(markDecorations(decos)).toHaveLength(1);
	});

	it("detects multiple wikilinks", () => {
		const doc = "text\n\n[[note]] and [[todo]]";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(2);
	});

	it("skips escaped wikilinks", () => {
		const doc = "text\n\n\\[[note]]";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		expect(markDecorations(decos)).toHaveLength(0);
	});

	it("returns empty set for document without wikilinks", () => {
		const view = createViewForTest("hello world\n\nno wikilinks here");
		const decos = collectDecorations(buildDecorations(view, fileMap));
		expect(decos).toHaveLength(0);
	});

	it("does not match empty wikilinks [[]]", () => {
		const view = createViewForTest("text\n\n[[]]");
		const decos = collectDecorations(buildDecorations(view, fileMap));
		expect(markDecorations(decos)).toHaveLength(0);
	});

	it("handles page name with .md extension", () => {
		const view = createViewForTest("text\n\n[[note.md]]", 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(1);
		const attrs = (marks[0].value.spec as { attributes: Record<string, string> }).attributes;
		expect(attrs["data-wikilink-exists"]).toBe("1");
	});

	it("detects wikilink without surrounding spaces", () => {
		const view = createViewForTest("text\n\nabc[[note]]def", 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(1);
		const attrs = (marks[0].value.spec as { attributes: Record<string, string> }).attributes;
		expect(attrs["data-wikilink-exists"]).toBe("1");
	});

	it("detects wikilink with kanji and no surrounding spaces", () => {
		const kanjiFileMap = buildFileMap(["/workspace/日記.md"]);
		const view = createViewForTest("text\n\nテスト[[日記]]です", 0);
		const decos = collectDecorations(buildDecorations(view, kanjiFileMap));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(1);
		const attrs = (marks[0].value.spec as { attributes: Record<string, string> }).attributes;
		expect(attrs["data-wikilink-exists"]).toBe("1");
	});

	it("detects wikilinks with kanji page names", () => {
		const kanjiFileMap = buildFileMap(["/workspace/日記.md"]);
		const view = createViewForTest("text\n\n[[日記]]", 0);
		const decos = collectDecorations(buildDecorations(view, kanjiFileMap));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(1);
		const doc = view.state.doc;
		const markText = doc.sliceString(marks[0].from, marks[0].to);
		expect(markText).toBe("日記");
	});

	it("matches NFC wikilink to NFD file name via normalization", () => {
		// File name in NFD: か(U+304B) + combining dakuten(U+3099) = が
		const nfdFileMap = buildFileMap(["/workspace/\u304B\u3099.md"]);
		// Wikilink in NFC: が(U+304C)
		const view = createViewForTest("text\n\n[[\u304C]]", 0);
		const decos = collectDecorations(buildDecorations(view, nfdFileMap));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(1);
		const attrs = (marks[0].value.spec as { attributes: Record<string, string> }).attributes;
		expect(attrs["data-wikilink-exists"]).toBe("1");
	});

	it("detects wikilink on first line when cursor is at position 0", () => {
		// Cursor at 0 means line 1 is the cursor line — wikilink should still render
		const view = createViewForTest("[[note]] some text", 0);
		const decos = collectDecorations(buildDecorations(view, fileMap));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(1);
	});

	it("detects wikilink on first line without cursor position", () => {
		const view = createViewForTest("[[note]] some text");
		const decos = collectDecorations(buildDecorations(view, fileMap));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(1);
	});
});
