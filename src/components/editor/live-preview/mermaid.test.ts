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

import { buildMermaidDecorations, findMermaidBlocks } from "./mermaid";
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
