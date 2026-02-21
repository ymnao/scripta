import { describe, expect, it } from "vitest";
import { buildDecorations } from "./code-blocks";
import {
	collectDecorations,
	createViewForTest,
	lineDecorations,
	replaceDecorations,
} from "./test-helper";

describe("buildDecorations", () => {
	it("creates line decorations for all lines including fences", () => {
		const view = createViewForTest("text\n\n```\ncode\n```");
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		expect(lines).toHaveLength(3);
	});

	it("creates replace decorations for fence lines", () => {
		const view = createViewForTest("text\n\n```\ncode\n```");
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		expect(replaces).toHaveLength(2);
	});

	it("creates replace decoration for language-specified fence", () => {
		const view = createViewForTest("text\n\n```js\nconst x = 1;\n```");
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		expect(replaces).toHaveLength(2);
	});

	it("creates 5 total decorations (3 line + 2 replace)", () => {
		const view = createViewForTest("text\n\n```\ncode\n```");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(5);
	});

	it("applies cm-codeblock-line class", () => {
		const view = createViewForTest("text\n\n```\ncode\n```");
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		for (const line of lines) {
			expect(line.value.spec.attributes.class).toBe("cm-codeblock-line");
		}
	});

	it("sets line decoration from at each line start", () => {
		const doc = "text\n\n```\ncode\n```";
		const view = createViewForTest(doc);
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		const fenceStart = doc.indexOf("```");
		const codeStart = doc.indexOf("code");
		const closeFenceStart = doc.lastIndexOf("```");
		expect(lines[0].from).toBe(fenceStart);
		expect(lines[1].from).toBe(codeStart);
		expect(lines[2].from).toBe(closeFenceStart);
	});

	it("handles language-specified fenced code", () => {
		const view = createViewForTest("text\n\n```js\nconst x = 1;\n```");
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		expect(lines).toHaveLength(3);
	});

	it("handles multi-line content", () => {
		const doc = "text\n\n```\nline1\nline2\nline3\n```";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		expect(lines).toHaveLength(5);
	});

	it("keeps all decorations when cursor is on code line", () => {
		const doc = "text\n\n```\ncode\n```";
		const cursorPos = doc.indexOf("code");
		const view = createViewForTest(doc, cursorPos);
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		const lines = lineDecorations(decos);
		expect(replaces).toHaveLength(2);
		expect(lines).toHaveLength(3);
	});

	it("shows opening fence when cursor is on it", () => {
		const doc = "text\n\n```\ncode\n```";
		const cursorPos = doc.indexOf("```");
		const view = createViewForTest(doc, cursorPos);
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		const lines = lineDecorations(decos);
		// Only closing fence is hidden
		expect(replaces).toHaveLength(1);
		expect(lines).toHaveLength(3);
	});

	it("shows closing fence when cursor is on it", () => {
		const doc = "text\n\n```\ncode\n```";
		const cursorPos = doc.lastIndexOf("```");
		const view = createViewForTest(doc, cursorPos);
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		const lines = lineDecorations(decos);
		// Only opening fence is hidden
		expect(replaces).toHaveLength(1);
		expect(lines).toHaveLength(3);
	});

	it("decorates multiple code blocks", () => {
		const doc = "text\n\n```\na\n```\n\n```\nb\n```";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		expect(lines).toHaveLength(6);
	});

	it("returns empty set for document without code blocks", () => {
		const view = createViewForTest("hello world\n\nno code here");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});
});
