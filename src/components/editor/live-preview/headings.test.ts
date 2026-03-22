import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { buildDecorations } from "./headings";
import {
	collectDecorations,
	createViewForTest,
	lineDecorations,
	replaceDecorations,
} from "./test-helper";

// Helper to dump syntax tree for debugging
function dumpTree(doc: string): string[] {
	const state = EditorState.create({
		doc,
		extensions: [markdown({ base: markdownLanguage })],
	});
	ensureSyntaxTree(state, state.doc.length, 5000);
	const tree = syntaxTree(state);
	const nodes: string[] = [];
	tree.iterate({
		from: 0,
		to: state.doc.length,
		enter(node) {
			const text = state.doc.sliceString(node.from, node.to);
			nodes.push(`${node.name}[${node.from}-${node.to}] "${text.replace(/\n/g, "\\n")}"`);
		},
	});
	return nodes;
}

describe("lezer parser behavior for headings", () => {
	it("parses # alone as ATXHeading1", () => {
		const nodes = dumpTree("#");
		expect(nodes.some((n) => n.startsWith("ATXHeading1"))).toBe(true);
		expect(nodes.some((n) => n.startsWith("HeaderMark"))).toBe(true);
	});

	it("parses ## alone as ATXHeading2", () => {
		const nodes = dumpTree("##");
		expect(nodes.some((n) => n.startsWith("ATXHeading2"))).toBe(true);
	});

	it("does NOT parse #text as heading", () => {
		const nodes = dumpTree("#text");
		expect(nodes.some((n) => n.startsWith("ATXHeading"))).toBe(false);
	});

	it("parses # followed by space as ATXHeading1", () => {
		const nodes = dumpTree("# ");
		expect(nodes.some((n) => n.startsWith("ATXHeading1"))).toBe(true);
	});

	it("parses ## text as ATXHeading2", () => {
		const nodes = dumpTree("## text");
		expect(nodes.some((n) => n.startsWith("ATXHeading2"))).toBe(true);
	});

	it("tree structure for # alone", () => {
		const nodes = dumpTree("#");
		// Verify HeaderMark position for # alone
		const headerMark = nodes.find((n) => n.startsWith("HeaderMark"));
		expect(headerMark).toBe('HeaderMark[0-1] "#"');
	});

	it("tree structure for ## alone", () => {
		const nodes = dumpTree("##");
		const headerMark = nodes.find((n) => n.startsWith("HeaderMark"));
		expect(headerMark).toBe('HeaderMark[0-2] "##"');
	});

	it("tree structure for ## text", () => {
		const nodes = dumpTree("## text");
		const headerMark = nodes.find((n) => n.startsWith("HeaderMark"));
		expect(headerMark).toBe('HeaderMark[0-2] "##"');
	});
});

describe("buildDecorations", () => {
	it("creates line + replace for ## text", () => {
		const view = createViewForTest("text\n\n## hello");
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		const replaces = replaceDecorations(decos);
		expect(lines).toHaveLength(1);
		expect(replaces).toHaveLength(1);
		expect(lines[0].value.spec.attributes.class).toBe("cm-heading-2");
	});

	it("replace covers ## and trailing space", () => {
		const doc = "text\n\n## hello";
		const view = createViewForTest(doc);
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		const hashStart = doc.indexOf("## ");
		expect(replaces[0].from).toBe(hashStart);
		expect(replaces[0].to).toBe(hashStart + 3);
	});

	it("should NOT decorate # alone (no space)", () => {
		const view = createViewForTest("text\n\n#");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});

	it("should NOT decorate ## alone (no space)", () => {
		const view = createViewForTest("text\n\n##");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});

	it("should NOT decorate ### alone (no space)", () => {
		const view = createViewForTest("text\n\n###");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});

	it("should decorate # followed by space", () => {
		const view = createViewForTest("text\n\n# ");
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		expect(lines).toHaveLength(1);
		expect(lines[0].value.spec.attributes.class).toBe("cm-heading-1");
	});

	it("should decorate ## followed by space and text", () => {
		const view = createViewForTest("text\n\n## hello");
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		const replaces = replaceDecorations(decos);
		expect(lines).toHaveLength(1);
		expect(replaces).toHaveLength(1);
		expect(lines[0].value.spec.attributes.class).toBe("cm-heading-2");
	});

	it("should preserve replace decoration for ## text", () => {
		const doc = "text\n\n## hello";
		const view = createViewForTest(doc);
		const decos = collectDecorations(buildDecorations(view));
		const replaces = replaceDecorations(decos);
		expect(replaces).toHaveLength(1);
		// Verify replace hides "## " (3 chars)
		const pos = doc.indexOf("##");
		expect(replaces[0].from).toBe(pos);
		expect(replaces[0].to).toBe(pos + 3);
	});

	it("handles multiple headings", () => {
		const view = createViewForTest("# h1\n\n## h2\n\n### h3");
		const decos = collectDecorations(buildDecorations(view));
		const lines = lineDecorations(decos);
		expect(lines).toHaveLength(3);
		expect(lines[0].value.spec.attributes.class).toBe("cm-heading-1");
		expect(lines[1].value.spec.attributes.class).toBe("cm-heading-2");
		expect(lines[2].value.spec.attributes.class).toBe("cm-heading-3");
	});

	it("returns empty set for non-heading content", () => {
		const view = createViewForTest("hello world\n\nno headings");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});
});
