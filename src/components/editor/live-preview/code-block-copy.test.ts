import { describe, expect, it } from "vitest";
import { buildCopyDecorations, CodeBlockCopyWidget } from "./code-block-copy";
import {
	collectDecorations,
	createViewForTest,
	lineDecorations,
	widgetDecorations,
} from "./test-helper";

describe("buildCopyDecorations", () => {
	it("creates widget decoration when cursor is outside code block", () => {
		const view = createViewForTest("text\n\n```\ncode\n```");
		const decos = collectDecorations(buildCopyDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
	});

	it("creates widget even when cursor is inside code block", () => {
		const doc = "text\n\n```\ncode\n```";
		const cursorPos = doc.indexOf("code");
		const view = createViewForTest(doc, cursorPos);
		const decos = collectDecorations(buildCopyDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
	});

	it("does not create widget for empty code blocks", () => {
		const view = createViewForTest("text\n\n```\n```");
		const decos = collectDecorations(buildCopyDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(0);
	});

	it("places widget at the end of first content line", () => {
		const doc = "text\n\n```\ncode\n```";
		const view = createViewForTest(doc);
		const decos = collectDecorations(buildCopyDecorations(view));
		const widgets = widgetDecorations(decos);
		const codeLineEnd = doc.indexOf("code") + "code".length;
		expect(widgets[0].from).toBe(codeLineEnd);
	});

	it("creates separate widgets for multiple code blocks", () => {
		const doc = "text\n\n```\na\n```\n\n```\nb\n```";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildCopyDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(2);
	});

	it("adds cm-codeblock-first class to first content line", () => {
		const doc = "text\n\n```\ncode\n```";
		const view = createViewForTest(doc);
		const decos = collectDecorations(buildCopyDecorations(view));
		const firstLineDecos = lineDecorations(decos).filter(
			(d) =>
				(d.value.spec as { attributes?: { class?: string } }).attributes?.class ===
				"cm-codeblock-first",
		);
		expect(firstLineDecos).toHaveLength(1);
		expect(firstLineDecos[0].from).toBe(doc.indexOf("code"));
	});

	it("does not create widget for mermaid blocks", () => {
		const view = createViewForTest("text\n\n```mermaid\ngraph TD\n```");
		const decos = collectDecorations(buildCopyDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(0);
	});
});

describe("CodeBlockCopyWidget", () => {
	it("eq returns true for same code", () => {
		const a = new CodeBlockCopyWidget("hello");
		const b = new CodeBlockCopyWidget("hello");
		expect(a.eq(b)).toBe(true);
	});

	it("eq returns false for different code", () => {
		const a = new CodeBlockCopyWidget("hello");
		const b = new CodeBlockCopyWidget("world");
		expect(a.eq(b)).toBe(false);
	});

	it("ignoreEvent returns true for mousedown", () => {
		const widget = new CodeBlockCopyWidget("code");
		expect(widget.ignoreEvent(new MouseEvent("mousedown"))).toBe(true);
	});

	it("ignoreEvent returns true for click", () => {
		const widget = new CodeBlockCopyWidget("code");
		expect(widget.ignoreEvent(new MouseEvent("click"))).toBe(true);
	});

	it("ignoreEvent returns true for keydown", () => {
		const widget = new CodeBlockCopyWidget("code");
		expect(widget.ignoreEvent(new KeyboardEvent("keydown"))).toBe(true);
	});

	it("ignoreEvent returns false for other events", () => {
		const widget = new CodeBlockCopyWidget("code");
		expect(widget.ignoreEvent(new FocusEvent("focus"))).toBe(false);
	});

	it("toDOM returns a focusable button element", () => {
		const widget = new CodeBlockCopyWidget("code");
		const el = widget.toDOM();
		expect(el.tagName).toBe("BUTTON");
		expect(el.tabIndex).not.toBe(-1);
	});

	function withMockClipboard(fn: (written: string[]) => Promise<void> | void) {
		return async () => {
			const original = navigator.clipboard;
			const written: string[] = [];
			Object.assign(navigator, {
				clipboard: {
					writeText: (text: string) => {
						written.push(text);
						return Promise.resolve();
					},
				},
			});
			try {
				await fn(written);
			} finally {
				Object.assign(navigator, { clipboard: original });
			}
		};
	}

	it(
		"click copies code to clipboard",
		withMockClipboard(async (written) => {
			const widget = new CodeBlockCopyWidget("hello world");
			const el = widget.toDOM();
			el.click();
			await Promise.resolve();
			expect(written).toEqual(["hello world"]);
		}),
	);

	it(
		"Enter key copies code to clipboard",
		withMockClipboard(async (written) => {
			const widget = new CodeBlockCopyWidget("hello world");
			const el = widget.toDOM();
			el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			await Promise.resolve();
			expect(written).toEqual(["hello world"]);
		}),
	);

	it(
		"Space key copies code to clipboard",
		withMockClipboard(async (written) => {
			const widget = new CodeBlockCopyWidget("hello world");
			const el = widget.toDOM();
			el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
			await Promise.resolve();
			expect(written).toEqual(["hello world"]);
		}),
	);
});
