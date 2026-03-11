import { describe, expect, it, vi } from "vitest";

// Mock mermaid cache module
vi.mock("../../../lib/mermaid", () => ({
	renderMermaid: vi.fn(),
	getCacheEntry: vi.fn(() => undefined),
	clearMermaidCache: vi.fn(),
}));

// Mock theme store
vi.mock("../../../stores/theme", () => ({
	useThemeStore: {
		getState: () => ({ theme: "light" as const }),
		subscribe: vi.fn(() => vi.fn()),
	},
}));

import { MermaidWidget, buildMermaidDecorations, findMermaidBlocks } from "./mermaid";
import {
	collectDecorations,
	createMockView,
	createTestState,
	replaceDecorations,
	widgetDecorations,
} from "./test-helper";

describe("findMermaidBlocks", () => {
	it("mermaid コードブロックを検出する", () => {
		const doc = "text\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nmore";
		const state = createTestState(doc);
		const blocks = findMermaidBlocks(state);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].source).toBe("graph TD\n  A-->B");
	});

	it("通常のコードブロックは無視する", () => {
		const doc = "```js\nconst x = 1;\n```";
		const state = createTestState(doc);
		const blocks = findMermaidBlocks(state);
		expect(blocks).toHaveLength(0);
	});

	it("空の mermaid ブロックはスキップする", () => {
		const doc = "```mermaid\n\n```";
		const state = createTestState(doc);
		const blocks = findMermaidBlocks(state);
		expect(blocks).toHaveLength(0);
	});

	it("複数の mermaid ブロックを検出する", () => {
		const doc =
			"```mermaid\ngraph TD\n  A-->B\n```\n\n```mermaid\nsequenceDiagram\n  A->>B: Hello\n```";
		const state = createTestState(doc);
		const blocks = findMermaidBlocks(state);
		expect(blocks).toHaveLength(2);
	});

	it("mermaid と通常のコードブロックが混在しても正しく検出する", () => {
		const doc =
			"```js\ncode\n```\n\n```mermaid\ngraph TD\n  A-->B\n```\n\n```python\nprint('hi')\n```";
		const state = createTestState(doc);
		const blocks = findMermaidBlocks(state);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].source).toBe("graph TD\n  A-->B");
	});
});

describe("MermaidWidget", () => {
	it("eq: 同じ source/svg/error なら true", () => {
		const a = new MermaidWidget("graph TD", "<svg/>", null);
		const b = new MermaidWidget("graph TD", "<svg/>", null);
		expect(a.eq(b)).toBe(true);
	});

	it("eq: source が異なれば false", () => {
		const a = new MermaidWidget("graph TD", "<svg/>", null);
		const b = new MermaidWidget("graph LR", "<svg/>", null);
		expect(a.eq(b)).toBe(false);
	});

	it("eq: svg が異なれば false", () => {
		const a = new MermaidWidget("graph TD", "<svg>1</svg>", null);
		const b = new MermaidWidget("graph TD", "<svg>2</svg>", null);
		expect(a.eq(b)).toBe(false);
	});

	it("eq: error が異なれば false", () => {
		const a = new MermaidWidget("bad", null, "parse error");
		const b = new MermaidWidget("bad", null, "other error");
		expect(a.eq(b)).toBe(false);
	});

	it("toDOM: SVG ありの場合 cm-mermaid-inner を含む", () => {
		const w = new MermaidWidget("graph TD", "<svg><text>hello</text></svg>", null);
		const el = w.toDOM();
		expect(el.className).toBe("cm-mermaid-widget");
		expect(el.querySelector(".cm-mermaid-inner")).not.toBeNull();
		expect(el.querySelector("svg")).not.toBeNull();
	});

	it("toDOM: エラーの場合 cm-mermaid-error を含む", () => {
		const w = new MermaidWidget("bad", null, "Syntax error");
		const el = w.toDOM();
		expect(el.querySelector(".cm-mermaid-error")?.textContent).toBe("Syntax error");
	});

	it("toDOM: ローディング状態の場合 cm-mermaid-loading を含む", () => {
		const w = new MermaidWidget("graph TD", null, null);
		const el = w.toDOM();
		expect(el.querySelector(".cm-mermaid-loading")).not.toBeNull();
	});
});

describe("buildMermaidDecorations", () => {
	it("カーソル外の mermaid ブロックでデコレーションを生成する", () => {
		const doc = "text\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nmore";
		const state = createTestState(doc, 0);
		const decos = collectDecorations(buildMermaidDecorations(state, true));
		const replaces = replaceDecorations(decos);
		expect(replaces).toHaveLength(1);
	});

	it("カーソルがブロック内にあるとデコレーションを生成しない", () => {
		const doc = "text\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nmore";
		const cursorPos = doc.indexOf("graph TD");
		const state = createTestState(doc, cursorPos);
		const decos = collectDecorations(buildMermaidDecorations(state, true));
		expect(decos).toHaveLength(0);
	});

	it("フォーカスがない場合はデコレーションを生成する", () => {
		const doc = "text\n\n```mermaid\ngraph TD\n  A-->B\n```";
		const state = createTestState(doc);
		const decos = collectDecorations(buildMermaidDecorations(state, false));
		const replaces = replaceDecorations(decos);
		expect(replaces).toHaveLength(1);
	});

	it("通常のコードブロックにはデコレーションを生成しない", () => {
		const doc = "```js\nconst x = 1;\n```";
		const state = createTestState(doc, 0);
		const decos = collectDecorations(buildMermaidDecorations(state, true));
		expect(decos).toHaveLength(0);
	});

	it("ウィジェットデコレーションが生成される", () => {
		const doc = "text\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nmore";
		const state = createTestState(doc, 0);
		const decos = collectDecorations(buildMermaidDecorations(state, true));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
	});
});
