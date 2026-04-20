import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { buildCopyDecorations, CodeBlockCopyWidget } from "./code-block-copy";
import {
	collectDecorations,
	createViewForTest,
	lineDecorations,
	widgetDecorations,
} from "./test-helper";

describe("buildCopyDecorations", () => {
	it("creates widget for code block in viewport", () => {
		const view = createViewForTest("text\n\n```\ncode\n```");
		const decos = collectDecorations(buildCopyDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
	});

	it("creates widget regardless of cursor position", () => {
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

	it("creates widget when viewport starts mid-codeblock", () => {
		const doc = "hello\n\n```\naaa\nbbb\nccc\n```";
		const bbbFrom = doc.indexOf("bbb");
		const cccEnd = doc.indexOf("ccc") + 3;
		const view = createViewForTest(doc, 0, [{ from: bbbFrom, to: cccEnd }]);
		const decos = collectDecorations(buildCopyDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		expect(widgets[0].from).toBe(bbbFrom + 3);
	});
});

describe("CodeBlockCopyWidget", () => {
	function createMockView(code: string, focusFn?: () => void) {
		return {
			state: { doc: { sliceString: () => code } },
			focus: focusFn ?? (() => {}),
		} as unknown as EditorView;
	}

	it("eq returns true for same range", () => {
		const a = new CodeBlockCopyWidget(0, 5);
		const b = new CodeBlockCopyWidget(0, 5);
		expect(a.eq(b)).toBe(true);
	});

	it("eq returns false for different range", () => {
		const a = new CodeBlockCopyWidget(0, 5);
		const b = new CodeBlockCopyWidget(0, 10);
		expect(a.eq(b)).toBe(false);
	});

	it("ignoreEvent returns true for mousedown", () => {
		const widget = new CodeBlockCopyWidget(0, 4);
		expect(widget.ignoreEvent(new MouseEvent("mousedown"))).toBe(true);
	});

	it("ignoreEvent returns true for click", () => {
		const widget = new CodeBlockCopyWidget(0, 4);
		expect(widget.ignoreEvent(new MouseEvent("click"))).toBe(true);
	});

	it("ignoreEvent returns true for Enter keydown", () => {
		const widget = new CodeBlockCopyWidget(0, 4);
		expect(widget.ignoreEvent(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(true);
	});

	it("ignoreEvent returns true for Space keydown", () => {
		const widget = new CodeBlockCopyWidget(0, 4);
		expect(widget.ignoreEvent(new KeyboardEvent("keydown", { key: " " }))).toBe(true);
	});

	it("ignoreEvent returns false for other keydown", () => {
		const widget = new CodeBlockCopyWidget(0, 4);
		expect(widget.ignoreEvent(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
	});

	it("ignoreEvent returns false for other events", () => {
		const widget = new CodeBlockCopyWidget(0, 4);
		expect(widget.ignoreEvent(new FocusEvent("focus"))).toBe(false);
	});

	it("toDOM returns a focusable button element", () => {
		const widget = new CodeBlockCopyWidget(0, 4);
		const el = widget.toDOM(createMockView("code"));
		expect(el.tagName).toBe("BUTTON");
		expect(el.tabIndex).not.toBe(-1);
	});

	function withMockClipboard(fn: (written: string[]) => Promise<void> | void) {
		return async () => {
			const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
			const written: string[] = [];
			Object.defineProperty(navigator, "clipboard", {
				value: {
					writeText: (text: string) => {
						written.push(text);
						return Promise.resolve();
					},
				},
				configurable: true,
			});
			try {
				await fn(written);
			} finally {
				if (descriptor) {
					Object.defineProperty(navigator, "clipboard", descriptor);
				} else {
					delete (navigator as unknown as Record<string, unknown>).clipboard;
				}
			}
		};
	}

	it(
		"click copies code to clipboard",
		withMockClipboard(async (written) => {
			const widget = new CodeBlockCopyWidget(0, 11);
			const el = widget.toDOM(createMockView("hello world"));
			el.click();
			await Promise.resolve();
			expect(written).toEqual(["hello world"]);
		}),
	);

	it(
		"Enter key copies code to clipboard and focuses editor",
		withMockClipboard(async (written) => {
			let focused = false;
			const widget = new CodeBlockCopyWidget(0, 11);
			const el = widget.toDOM(
				createMockView("hello world", () => {
					focused = true;
				}),
			);
			el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			await Promise.resolve();
			expect(written).toEqual(["hello world"]);
			expect(focused).toBe(true);
		}),
	);

	it(
		"Space key copies code to clipboard and focuses editor",
		withMockClipboard(async (written) => {
			let focused = false;
			const widget = new CodeBlockCopyWidget(0, 11);
			const el = widget.toDOM(
				createMockView("hello world", () => {
					focused = true;
				}),
			);
			el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
			await Promise.resolve();
			expect(written).toEqual(["hello world"]);
			expect(focused).toBe(true);
		}),
	);

	it(
		"destroy clears the feedback timer",
		withMockClipboard(async () => {
			vi.useFakeTimers();
			try {
				const widget = new CodeBlockCopyWidget(0, 4);
				const el = widget.toDOM(createMockView("code"));
				el.click();
				await Promise.resolve();
				expect(el.classList.contains("cm-codeblock-copy-success")).toBe(true);
				widget.destroy(el);
				vi.advanceTimersByTime(2000);
				// タイマーがクリアされたため、時間が経過してもクラスが残る
				expect(el.classList.contains("cm-codeblock-copy-success")).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		}),
	);
});
