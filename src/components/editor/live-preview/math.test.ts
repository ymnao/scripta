import { describe, expect, it, vi } from "vitest";
import { MathWidget, buildDecorations, isEscaped } from "./math";
import { collectDecorations, createViewForTest, widgetDecorations } from "./test-helper";

vi.mock("katex", () => ({
	default: {
		render: vi.fn((tex: string, element: HTMLElement, options: { displayMode: boolean }) => {
			element.textContent = `rendered:${options.displayMode ? "display" : "inline"}:${tex}`;
		}),
	},
}));

describe("isEscaped", () => {
	it("returns false when there is no preceding backslash", () => {
		expect(isEscaped("$x$", 0)).toBe(false);
	});

	it("returns true when preceded by a single backslash", () => {
		expect(isEscaped("\\$x$", 1)).toBe(true);
	});

	it("returns false when preceded by two backslashes", () => {
		expect(isEscaped("\\\\$x$", 2)).toBe(false);
	});

	it("returns true when preceded by three backslashes", () => {
		expect(isEscaped("\\\\\\$x$", 3)).toBe(true);
	});
});

describe("MathWidget", () => {
	it("eq returns true for same tex and displayMode", () => {
		const w1 = new MathWidget("x^2", false);
		const w2 = new MathWidget("x^2", false);
		expect(w1.eq(w2)).toBe(true);
	});

	it("eq returns false for different tex", () => {
		const w1 = new MathWidget("x^2", false);
		const w2 = new MathWidget("y^2", false);
		expect(w1.eq(w2)).toBe(false);
	});

	it("eq returns false for different displayMode", () => {
		const w1 = new MathWidget("x^2", false);
		const w2 = new MathWidget("x^2", true);
		expect(w1.eq(w2)).toBe(false);
	});

	it("toDOM creates element with correct class for inline", () => {
		const w = new MathWidget("x^2", false);
		const el = w.toDOM();
		expect(el.className).toBe("cm-math-inline");
	});

	it("toDOM creates element with correct class for display", () => {
		const w = new MathWidget("x^2", true);
		const el = w.toDOM();
		expect(el.className).toBe("cm-math-display");
	});

	it("ignoreEvent returns false so the editor handles events as fallback", () => {
		const w = new MathWidget("x^2", false);
		expect(w.ignoreEvent(new MouseEvent("mousedown"))).toBe(false);
	});
});

describe("buildDecorations", () => {
	it("detects inline math", () => {
		const view = createViewForTest("text\n\nHello $x^2$ world", 0);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidget };
		expect(spec.widget.tex).toBe("x^2");
		expect(spec.widget.displayMode).toBe(false);
	});

	it("detects single-line display math", () => {
		const view = createViewForTest("text\n\n$$E=mc^2$$", 0);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidget };
		expect(spec.widget.tex).toBe("E=mc^2");
		expect(spec.widget.displayMode).toBe(true);
	});

	it("detects multi-line display math", () => {
		const doc = "text\n\n$$\nx^2 + y^2\n$$";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidget };
		expect(spec.widget.tex).toBe("\nx^2 + y^2\n");
		expect(spec.widget.displayMode).toBe(true);
	});

	it("excludes math inside fenced code blocks", () => {
		const doc = "text\n\n```\n$x^2$\n```";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view));
		expect(widgetDecorations(decos)).toHaveLength(0);
	});

	it("excludes math inside inline code", () => {
		const doc = "text\n\n`$x^2$` here";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view));
		expect(widgetDecorations(decos)).toHaveLength(0);
	});

	it("excludes escaped dollar sign", () => {
		const doc = "text\n\n\\$x^2\\$";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view));
		expect(widgetDecorations(decos)).toHaveLength(0);
	});

	it("skips math on cursor line", () => {
		const doc = "text\n\nHello $x^2$ world";
		const cursorPos = doc.indexOf("$x^2$");
		const view = createViewForTest(doc, cursorPos);
		const decos = collectDecorations(buildDecorations(view));
		expect(widgetDecorations(decos)).toHaveLength(0);
	});

	it("does not detect $ inside $$ as inline math", () => {
		const doc = "text\n\n$$a + b$$";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		// Should detect only display math, not inline
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidget };
		expect(spec.widget.displayMode).toBe(true);
	});

	it("handles multiple inline math expressions", () => {
		const doc = "text\n\n$a$ and $b$ here";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(2);
	});

	it("returns empty set for document without math", () => {
		const view = createViewForTest("hello world\n\nno math here");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});

	it("only detects math within the visible viewport", () => {
		// Line 1: "aaa $x$"  (offset 0–6, newline at 7)
		// Line 2: ""          (offset 8)
		// Line 3: "bbb $y$"  (offset 9–15)
		const doc = "aaa $x$\n\nbbb $y$";
		// Cursor on empty line 2 (pos 8) so math lines are not skipped
		// Viewport covers only the first line
		const view = createViewForTest(doc, 8, [{ from: 0, to: 7 }]);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidget };
		expect(spec.widget.tex).toBe("x");
	});

	it("detects math only in second viewport range", () => {
		const doc = "aaa $x$\n\nbbb $y$";
		// Viewport covers only the third line (offset 9–16)
		const view = createViewForTest(doc, 0, [{ from: 9, to: 16 }]);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidget };
		expect(spec.widget.tex).toBe("y");
	});

	it("handles split viewport ranges", () => {
		const doc = "aaa $x$\n\nbbb $y$";
		// Cursor on empty line 2 (pos 8) so math lines are not skipped
		// Two disjoint viewport ranges covering both math expressions
		const view = createViewForTest(doc, 8, [
			{ from: 0, to: 7 },
			{ from: 9, to: 16 },
		]);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(2);
	});

	it("ignores math outside viewport even in a long document", () => {
		const doc = "line1\n\n$a$\n\nline3\n\n$b$\n\nline5";
		// Viewport covers only the middle section (line3)
		const line3From = doc.indexOf("line3");
		const line3To = line3From + "line3".length;
		const view = createViewForTest(doc, 0, [{ from: line3From, to: line3To }]);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(0);
	});
});
