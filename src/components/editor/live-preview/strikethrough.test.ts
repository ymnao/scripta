import { describe, expect, it } from "vitest";
import { buildDecorations } from "./strikethrough";
import { collectDecorations, createViewForTest, markDecorations } from "./test-helper";

describe("buildDecorations", () => {
	it("hides StrikethroughMark and applies cm-strikethrough class", () => {
		const view = createViewForTest("text\n\n~~deleted~~");
		const decos = collectDecorations(buildDecorations(view));
		const marks = markDecorations(decos);
		// 2 replace for ~~ markers + 1 mark for content = 3
		expect(decos).toHaveLength(3);
		expect(marks).toHaveLength(1);
		expect((marks[0].value.spec as { class: string }).class).toBe("cm-strikethrough");
	});

	it("skips strikethrough on cursor line", () => {
		const doc = "text\n\n~~deleted~~";
		const cursorPos = doc.indexOf("~~deleted~~");
		const view = createViewForTest(doc, cursorPos);
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});

	it("handles multiple strikethroughs", () => {
		const doc = "text\n\n~~one~~ and ~~two~~";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view));
		const marks = markDecorations(decos);
		expect(marks).toHaveLength(2);
	});

	it("returns empty set for document without strikethrough", () => {
		const view = createViewForTest("hello world\n\nno strikethrough here");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});
});
