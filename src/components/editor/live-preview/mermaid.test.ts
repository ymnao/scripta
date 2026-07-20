import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock mermaid cache module
vi.mock("../../../lib/mermaid", () => ({
	renderMermaid: vi.fn(),
	getCacheEntry: vi.fn(() => undefined),
	clearMermaidCache: vi.fn(),
	shouldSkipMermaidInitRetry: vi.fn(() => false),
	isMermaidInitFailureExhausted: vi.fn(() => false),
}));

// Mock theme store
vi.mock("../../../stores/theme", () => ({
	useThemeStore: {
		getState: () => ({ theme: "light" as const }),
		subscribe: vi.fn(() => vi.fn()),
	},
}));

// Mock settings store
vi.mock("../../../stores/settings", () => ({
	useSettingsStore: {
		getState: () => ({ fontFamily: "monospace", fontSize: 14 }),
		subscribe: vi.fn(() => vi.fn()),
	},
}));

import * as mermaidLib from "../../../lib/mermaid";
import {
	buildMermaidDecorations,
	findMermaidBlocks,
	INIT_FAILURE_MESSAGE,
	MermaidWidget,
	mermaidDecoration,
	mermaidDecorationField,
} from "./mermaid";
import { treeParseProgressed } from "./plugin-utils";
import {
	collectDecorations,
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

// mermaidDecorationField の差分再構築判定テスト (#303 Phase 3)。math.test.ts の
// mathDecorationField (StateField diff rebuild) describe と同型。
// rebuild が起きたかどうかは「既存 mermaid の widget オブジェクト参照が保たれているか」で
// 判定する:
// - skip path (`decos.map` + `mapCandidates`) は RangeSet.map で既存の Decoration/Widget
//   オブジェクトをそのまま使い回す（位置だけ shift される）
// - full rebuild path (`buildMermaidDecorationsAndCandidates`) は常に新しい MermaidWidget
//   インスタンスを生成する（内容が同じでも参照は別物になる）
describe("mermaidDecorationField (StateField diff rebuild)", () => {
	function makeState(doc: string, selection?: EditorSelection): EditorState {
		let state = EditorState.create({
			doc,
			selection,
			extensions: [markdown({ base: markdownLanguage }), mermaidDecoration],
		});
		ensureSyntaxTree(state, state.doc.length, Number.POSITIVE_INFINITY);
		// LanguageState.apply の tree 同期を発火させる (test-helper.ts の createTestState と同型)。
		state = state.update({}).state;
		return state;
	}

	interface WidgetEntry {
		from: number;
		to: number;
		widget: MermaidWidget;
	}

	function getWidgets(state: EditorState): WidgetEntry[] {
		const value = state.field(mermaidDecorationField);
		const out: WidgetEntry[] = [];
		const iter = value.decos.iter();
		while (iter.value) {
			const spec = iter.value.spec as { widget?: MermaidWidget };
			if (spec.widget) out.push({ from: iter.from, to: iter.to, widget: spec.widget });
			iter.next();
		}
		return out;
	}

	function candidateCount(state: EditorState): number {
		return state.field(mermaidDecorationField).candidates.length;
	}

	it("mermaid ブロックから離れた位置への非 fence (`/~ 以外) 挿入は rebuild を回避し、widget 参照を維持したまま位置を map する", () => {
		// line1: "line one", line2: "", line3: "```mermaid", line4: "graph TD",
		// line5: "  A-->B", line6: "```", line7: "", line8: "line after"
		const doc = "line one\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nline after";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const [{ widget: originalWidget, from: originalFrom, to: originalTo }] = before;

		// line1 の先頭に挿入。mermaid (line3-6) の pad 範囲 (line2..line7) に触れない。
		const tr = state.update({ changes: { from: 0, to: 0, insert: "XXXXX " } });
		const after = getWidgets(tr.state);

		expect(after).toHaveLength(1);
		expect(after[0].widget).toBe(originalWidget);
		expect(after[0].from).toBe(originalFrom + 6);
		expect(after[0].to).toBe(originalTo + 6);
		expect(candidateCount(tr.state)).toBe(candidateCount(state));
	});

	it("離れた位置へ ` を 1 文字挿入すると full rebuild が走る", () => {
		const doc = "line one\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nline after";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;

		// 離れた行に ` を単体挿入 (新規候補が生まれうる文字)。
		const tr = state.update({ changes: { from: 0, to: 0, insert: "`" } });
		const after = getWidgets(tr.state);

		expect(after).toHaveLength(1);
		expect(after[0].widget).not.toBe(originalWidget);
	});

	it("既存の mermaid ブロック内部を編集すると full rebuild が走る", () => {
		const doc = "line one\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nline after";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;

		// "graph TD" (line4) の中身を書き換える (block 範囲内部の編集)。
		const line4From = state.doc.line(4).from;
		const tr = state.update({ changes: { from: line4From, to: line4From, insert: "X" } });
		const after = getWidgets(tr.state);

		expect(after).toHaveLength(1);
		expect(after[0].widget).not.toBe(originalWidget);
	});

	it("既存の mermaid ブロックの隣接行 (±1 行) を編集すると full rebuild が走る", () => {
		const doc = "line one\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nline after";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;

		// mermaid の直前の空行 (line2) に挿入する。
		const line2From = state.doc.line(2).from;
		const tr = state.update({ changes: { from: line2From, to: line2From, insert: "y" } });
		const after = getWidgets(tr.state);

		expect(after).toHaveLength(1);
		expect(after[0].widget).not.toBe(originalWidget);
	});

	it("mermaid のない行から別の mermaid のない行へカーソル移動しても rebuild しない", () => {
		const doc = "line one\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nline after";
		const state = makeState(doc, EditorSelection.single(0));
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;

		// line1 → line8、どちらも mermaid の pad 範囲 (line2..line7) に含まれない。
		const line8From = state.doc.line(8).from;
		const tr = state.update({ selection: EditorSelection.cursor(line8From) });
		const after = getWidgets(tr.state);

		expect(after).toHaveLength(1);
		expect(after[0].widget).toBe(originalWidget);
	});

	it("mermaid ブロック内へカーソルが出入りすると rebuild する (widget ⇔ ソース表示の切替に必要)", () => {
		const doc = "line one\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nline after";
		const state = makeState(doc, EditorSelection.single(0));
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;

		const line4From = state.doc.line(4).from;
		const tr = state.update({ selection: EditorSelection.cursor(line4From) });
		const after = getWidgets(tr.state);

		// hasFocus は field 作成時点で false のまま (queueMicrotask 経由の focus effect は
		// EditorView なしでは発火しない) なので、cursorLines 自体は空集合のまま widget は
		// 引き続き描画される。ここで検証したいのは「rebuild が起きたか」であり、
		// widget 参照の入れ替わりで判定する。
		expect(after).toHaveLength(1);
		expect(after[0].widget).not.toBe(originalWidget);
	});

	it("削除で mermaid fence が消えるケースでは full rebuild が走る", () => {
		const doc = "line one\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nline after";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);

		// 開き fence 全体 (line3) を削除し、mermaid ブロックを壊す。
		const line3 = state.doc.line(3);
		const tr = state.update({ changes: { from: line3.from, to: line3.to + 1, insert: "" } });
		const after = getWidgets(tr.state);

		expect(after).toHaveLength(0);
	});

	it("CRLF 改行を含む挿入・削除でも行判定が正しく機能する (改行前後の row 判定漏れ防止)", () => {
		const doc = "line one\r\n\r\n```mermaid\r\ngraph TD\r\n  A-->B\r\n```\r\n\r\nline after";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;
		const originalFrom = before[0].from;
		const originalTo = before[0].to;

		// 遠い行 (先頭) への非 fence 挿入 → skip path、CRLF でも位置 map が正しいことを確認。
		const tr1 = state.update({ changes: { from: 0, to: 0, insert: "zzzz" } });
		const after1 = getWidgets(tr1.state);
		expect(after1).toHaveLength(1);
		expect(after1[0].widget).toBe(originalWidget);
		expect(after1[0].from).toBe(originalFrom + 4);
		expect(after1[0].to).toBe(originalTo + 4);

		// mermaid の隣接行 (直前の空行) への挿入 → CRLF 環境でも rebuild が正しく検知される。
		const line2From = tr1.state.doc.line(2).from;
		const tr2 = tr1.state.update({ changes: { from: line2From, to: line2From, insert: "w" } });
		const after2 = getWidgets(tr2.state);
		expect(after2).toHaveLength(1);
		expect(after2[0].widget).not.toBe(after1[0].widget);
	});

	it("treeParseProgressed 効果を dispatch すると full rebuild が走る", () => {
		const doc = "line one\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nline after";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;

		const tr = state.update({ effects: [treeParseProgressed.of(null)] });
		const after = getWidgets(tr.state);

		expect(after).toHaveLength(1);
		expect(after[0].widget).not.toBe(originalWidget);
	});
});

// issue #384: back-off の実体は lib 側 (グローバル 1 record) に移した。
// live-preview に残るのは lib API との結線検証のみ。
describe("init-failure UI wiring (issue #384)", () => {
	beforeEach(() => {
		vi.mocked(mermaidLib.getCacheEntry).mockReset();
		vi.mocked(mermaidLib.getCacheEntry).mockReturnValue(undefined);
		vi.mocked(mermaidLib.isMermaidInitFailureExhausted).mockReset();
		vi.mocked(mermaidLib.isMermaidInitFailureExhausted).mockReturnValue(false);
	});

	it("isMermaidInitFailureExhausted=false のときは widget が loading 表示のまま", () => {
		vi.mocked(mermaidLib.isMermaidInitFailureExhausted).mockReturnValue(false);
		const doc = "```mermaid\ngraph TD\n  A-->B\n```";
		const state = createTestState(doc);

		const decos = collectDecorations(buildMermaidDecorations(state, false));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const widget = (widgets[0].value.spec as { widget: MermaidWidget }).widget;
		expect(widget).toBeInstanceOf(MermaidWidget);
		expect(widget.error).toBeNull();
		expect(widget.svg).toBeNull();
	});

	it("cache entry undefined + isMermaidInitFailureExhausted=true で widget が INIT_FAILURE_MESSAGE を表示", () => {
		vi.mocked(mermaidLib.getCacheEntry).mockReturnValue(undefined);
		vi.mocked(mermaidLib.isMermaidInitFailureExhausted).mockReturnValue(true);
		const doc = "```mermaid\ngraph TD\n  A-->B\n```";
		const state = createTestState(doc);

		const decos = collectDecorations(buildMermaidDecorations(state, false));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const widget = (widgets[0].value.spec as { widget: MermaidWidget }).widget;
		expect(widget.error).toBe(INIT_FAILURE_MESSAGE);
	});

	it("cache entry が rendered のときは isMermaidInitFailureExhausted=true でも SVG を優先表示", () => {
		vi.mocked(mermaidLib.getCacheEntry).mockReturnValue({
			status: "rendered",
			svg: "<svg><text>ok</text></svg>",
		} as unknown as ReturnType<typeof mermaidLib.getCacheEntry>);
		vi.mocked(mermaidLib.isMermaidInitFailureExhausted).mockReturnValue(true);
		const doc = "```mermaid\ngraph TD\n  A-->B\n```";
		const state = createTestState(doc);

		const decos = collectDecorations(buildMermaidDecorations(state, false));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const widget = (widgets[0].value.spec as { widget: MermaidWidget }).widget;
		expect(widget.svg).toBe("<svg><text>ok</text></svg>");
		expect(widget.error).toBeNull();
	});

	it("cache entry が per-source error のときは INIT_FAILURE_MESSAGE ではなく元 message を表示 (PR #312 非退行)", () => {
		vi.mocked(mermaidLib.getCacheEntry).mockReturnValue({
			status: "error",
			message: "Parse error",
		} as unknown as ReturnType<typeof mermaidLib.getCacheEntry>);
		vi.mocked(mermaidLib.isMermaidInitFailureExhausted).mockReturnValue(true);
		const doc = "```mermaid\ngraph TD\n  A-->B\n```";
		const state = createTestState(doc);

		const decos = collectDecorations(buildMermaidDecorations(state, false));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const widget = (widgets[0].value.spec as { widget: MermaidWidget }).widget;
		expect(widget.error).toBe("Parse error");
	});
});
