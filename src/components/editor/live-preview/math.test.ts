import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MathWidget as MathWidgetType } from "./math";

const renderToStringMock = vi.fn(
	(tex: string, options: { displayMode: boolean }) =>
		`rendered:${options.displayMode ? "display" : "inline"}:${tex}`,
);

vi.mock("katex", () => ({
	default: {
		renderToString: renderToStringMock,
	},
}));

// katex.min.css は動的 import 対象。vitest の css transform (no-op) に任せてよいが、
// 明示的にモックして依存を軽くする。
vi.mock("katex/dist/katex.min.css", () => ({}));

const {
	buildMathDecorations,
	isEscaped,
	MathWidget,
	mathDecoration,
	mathDecorationField,
	preloadKatexForTest,
} = await import("./math");
const { collectDecorations, createViewForTest, widgetDecorations } = await import("./test-helper");

// MathWidget.toDOM は katex の動的 import 完了後にのみ同期 render される
// (#301: lazy-load 化）。同期 toDOM を前提とする既存テストのために、
// スイート開始前に katex のロードを済ませておく。
beforeAll(async () => {
	await preloadKatexForTest();
});

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

	it("同一 tex + displayMode の2回目の toDOM では renderToString を再実行しない（render cache）", () => {
		renderToStringMock.mockClear();
		const tex = `cache-test-${Math.random()}`;
		const w1 = new MathWidget(tex, false);
		const w2 = new MathWidget(tex, false);
		w1.toDOM();
		w2.toDOM();
		expect(renderToStringMock).toHaveBeenCalledTimes(1);
	});

	it("displayMode が異なると別キャッシュエントリとして扱われる", () => {
		renderToStringMock.mockClear();
		const tex = `cache-test-display-${Math.random()}`;
		new MathWidget(tex, false).toDOM();
		new MathWidget(tex, true).toDOM();
		expect(renderToStringMock).toHaveBeenCalledTimes(2);
	});
});

describe("MathWidget katex lazy-load", () => {
	// beforeAll で preloadKatexForTest 済みの top-level モジュールではロード前状態を
	// 踏めないため、vi.resetModules() でフレッシュなモジュールインスタンス
	// （katexMod = null）を取得して検証する。vi.mock の factory はモジュール
	// registry のリセット後も有効なので、フレッシュ import でも katex はモック。
	it("ロード前の toDOM は cm-math-loading placeholder を返し、ロード前後の widget は eq=false になる", async () => {
		vi.resetModules();
		const fresh = await import("./math");

		// (a) ロード前: placeholder（生 TeX テキスト）
		const before = new fresh.MathWidget("x^2", false);
		const placeholderEl = before.toDOM();
		expect(placeholderEl.classList.contains("cm-math-loading")).toBe(true);
		expect(placeholderEl.textContent).toBe("x^2");

		// (b) ロード後: 同じ tex + displayMode でも eq=false（toDOM 再実行が保証される）
		await fresh.preloadKatexForTest();
		const after = new fresh.MathWidget("x^2", false);
		expect(before.eq(after)).toBe(false);
		expect(after.eq(before)).toBe(false);

		// ロード後の widget は同期 render される（placeholder ではない）
		const renderedEl = after.toDOM();
		expect(renderedEl.classList.contains("cm-math-loading")).toBe(false);
		expect(renderedEl.className).toBe("cm-math-inline");
		expect(renderedEl.innerHTML).toContain("rendered:inline:x^2");
	});

	it("同一ロード状態の widget 同士は eq=true のまま（既存の DOM 再利用を壊さない）", () => {
		const w1 = new MathWidget("x^2", false);
		const w2 = new MathWidget("x^2", false);
		expect(w1.eq(w2)).toBe(true);
	});
});

describe("buildDecorations", () => {
	it("detects inline math", () => {
		const view = createViewForTest("text\n\nHello $x^2$ world", 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidgetType };
		expect(spec.widget.tex).toBe("x^2");
		expect(spec.widget.displayMode).toBe(false);
	});

	it("detects single-line display math", () => {
		const view = createViewForTest("text\n\n$$E=mc^2$$", 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidgetType };
		expect(spec.widget.tex).toBe("E=mc^2");
		expect(spec.widget.displayMode).toBe(true);
	});

	it("detects multi-line display math", () => {
		const doc = "text\n\n$$\nx^2 + y^2\n$$";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidgetType };
		expect(spec.widget.tex).toBe("\nx^2 + y^2\n");
		expect(spec.widget.displayMode).toBe(true);
	});

	it("excludes math inside fenced code blocks", () => {
		const doc = "text\n\n```\n$x^2$\n```";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		expect(widgetDecorations(decos)).toHaveLength(0);
	});

	it("excludes math inside inline code", () => {
		const doc = "text\n\n`$x^2$` here";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		expect(widgetDecorations(decos)).toHaveLength(0);
	});

	it("excludes escaped dollar sign", () => {
		const doc = "text\n\n\\$x^2\\$";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		expect(widgetDecorations(decos)).toHaveLength(0);
	});

	it("skips math on cursor line", () => {
		const doc = "text\n\nHello $x^2$ world";
		const cursorPos = doc.indexOf("$x^2$");
		const view = createViewForTest(doc, cursorPos);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		expect(widgetDecorations(decos)).toHaveLength(0);
	});

	it("does not detect $ inside $$ as inline math", () => {
		const doc = "text\n\n$$a + b$$";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		// Should detect only display math, not inline
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidgetType };
		expect(spec.widget.displayMode).toBe(true);
	});

	it("handles multiple inline math expressions", () => {
		const doc = "text\n\n$a$ and $b$ here";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(2);
	});

	it("returns empty set for document without math", () => {
		const view = createViewForTest("hello world\n\nno math here");
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		expect(decos).toHaveLength(0);
	});

	// math.ts の hybrid 化（StateField + ViewPlugin）で viewport 制限が撤去され
	// state ベースで doc 全体を scan する仕様に変わったため、viewport 制限を前提
	// とした旧テストはそのままでは意図が成立しない。新仕様での挙動カバレッジは
	// 後続 PR で追加予定。
	it.skip("only detects math within the visible viewport", () => {
		// Line 1: "aaa $x$"  (offset 0–6, newline at 7)
		// Line 2: ""          (offset 8)
		// Line 3: "bbb $y$"  (offset 9–15)
		const doc = "aaa $x$\n\nbbb $y$";
		// Cursor on empty line 2 (pos 8) so math lines are not skipped
		// Viewport covers only the first line
		const view = createViewForTest(doc, 8, [{ from: 0, to: 7 }]);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidgetType };
		expect(spec.widget.tex).toBe("x");
	});

	it("detects math only in second viewport range", () => {
		const doc = "aaa $x$\n\nbbb $y$";
		// Viewport covers only the third line (offset 9–16)
		const view = createViewForTest(doc, 0, [{ from: 9, to: 16 }]);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidgetType };
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
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(2);
	});

	it("does not treat escaped closing $ as math delimiter", () => {
		const doc = "text\n\n$100 and also \\$200";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		expect(widgetDecorations(decos)).toHaveLength(0);
	});

	it("treats \\\\$ as literal backslash followed by math delimiter", () => {
		const doc = "text\n\n\\\\$x^2$";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidgetType };
		expect(spec.widget.tex).toBe("x^2");
		expect(spec.widget.displayMode).toBe(false);
	});

	it("does not treat escaped closing $$ as display math", () => {
		// $$foo\$$ — the closing $$ has its first $ escaped,
		// so display math is rejected. The inline regex then picks up
		// $foo\$ as inline math (starting from the second $ of $$).
		const doc = "text\n\n$$foo\\$$";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		// No display math, but inline finds $foo\$
		const display = widgets.filter(
			(w) => (w.value.spec as { widget: MathWidgetType }).widget.displayMode,
		);
		expect(display).toHaveLength(0);
	});

	it("renders escaped $ inside inline math as literal dollar", () => {
		const doc = "text\n\n$ 50 \\$ $";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		const spec = widgets[0].value.spec as { widget: MathWidgetType };
		expect(spec.widget.tex).toBe(" 50 \\$ ");
		expect(spec.widget.displayMode).toBe(false);
	});

	it("detects inline math after display math on same line", () => {
		const doc = "text\n\n$$a$$ $b$";
		const view = createViewForTest(doc, 0);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(2);
		const display = widgets.find(
			(w) => (w.value.spec as { widget: MathWidgetType }).widget.displayMode,
		);
		const inline = widgets.find(
			(w) => !(w.value.spec as { widget: MathWidgetType }).widget.displayMode,
		);
		expect(display).toBeDefined();
		expect(inline).toBeDefined();
		expect((inline?.value.spec as { widget: MathWidgetType }).widget.tex).toBe("b");
	});

	// 同上: viewport 制限撤去により旧仕様テストは意図が成立しない。
	it.skip("ignores math outside viewport even in a long document", () => {
		const doc = "line1\n\n$a$\n\nline3\n\n$b$\n\nline5";
		// Viewport covers only the middle section (line3)
		const line3From = doc.indexOf("line3");
		const line3To = line3From + "line3".length;
		const view = createViewForTest(doc, 0, [{ from: line3From, to: line3To }]);
		const decos = collectDecorations(buildMathDecorations(view.state, view.hasFocus));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(0);
	});
});

// mathDecorationField.update() の差分再構築 (#303) を、EditorView / 実 focus イベントなしに
// pure EditorState.update() で検証する。field は EditorState 単体で動作する (ViewPlugin
// 部分の mathFocusHandler 等は無関係) ため、州 (state) レベルのテストで rebuild / skip
// 判定を直接担保できる。
//
// rebuild が起きたかどうかは「既存 math の widget オブジェクト参照が保たれているか」で判定する:
// - skip path (`decos.map` + `mapCandidates`) は RangeSet.map で既存の Decoration/Widget
//   オブジェクトをそのまま使い回す（位置だけ shift される）
// - full rebuild path (`buildMathDecorationsAndCandidates`) は常に新しい MathWidget
//   インスタンスを生成する（内容が同じでも参照は別物になる）
// vi.spyOn によるコール検知は Vite/Vitest の ESM 変換下では同一モジュール内呼び出しを
// 素通りしてしまい機能しないため（同一モジュール内の直接呼び出しは export バインディング
// 経由ではないため spy が引っかからない）、widget 参照比較という外部から観測可能な副作用で
// 代替する。
describe("mathDecorationField (StateField diff rebuild)", () => {
	function makeState(doc: string, selection?: EditorSelection): EditorState {
		let state = EditorState.create({
			doc,
			selection,
			extensions: [markdown({ base: markdownLanguage }), mathDecoration],
		});
		ensureSyntaxTree(state, state.doc.length, Number.POSITIVE_INFINITY);
		// LanguageState.apply の tree 同期を発火させる (test-helper.ts の createTestState と同型)。
		state = state.update({}).state;
		return state;
	}

	interface WidgetEntry {
		from: number;
		to: number;
		widget: MathWidgetType;
	}

	function getWidgets(state: EditorState): WidgetEntry[] {
		const value = state.field(mathDecorationField);
		const out: WidgetEntry[] = [];
		const iter = value.decos.iter();
		while (iter.value) {
			const spec = iter.value.spec as { widget?: MathWidgetType };
			if (spec.widget) out.push({ from: iter.from, to: iter.to, widget: spec.widget });
			iter.next();
		}
		return out;
	}

	function candidateCount(state: EditorState): number {
		return state.field(mathDecorationField).candidates.length;
	}

	it("数式から離れた位置への非 $ 挿入は rebuild を回避し、widget 参照を維持したまま位置を map する", () => {
		// line1: "hello world", line2: "", line3: "$$disp$$", line4: "", line5: "after math text"
		const doc = "hello world\n\n$$disp$$\n\nafter math text";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const [{ widget: originalWidget, from: originalFrom, to: originalTo }] = before;

		// line1 の先頭に挿入。math (line3) の pad 範囲 (line2..line4) に触れない。
		const tr = state.update({ changes: { from: 0, to: 0, insert: "XXXXX " } });
		const after = getWidgets(tr.state);

		expect(after).toHaveLength(1);
		expect(after[0].widget).toBe(originalWidget);
		expect(after[0].from).toBe(originalFrom + 6);
		expect(after[0].to).toBe(originalTo + 6);
		expect(candidateCount(tr.state)).toBe(candidateCount(state));
	});

	it("$ を 1 文字挿入すると full rebuild が走り、新しい候補が反映される", () => {
		const doc = "hello world\n\n$$disp$$\n\nafter math text";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;
		const originalCandidateCount = candidateCount(state);

		// 離れた行に $ を単体挿入 (新規候補が生まれうる文字)。
		const tr = state.update({ changes: { from: 0, to: 0, insert: "$" } });
		const after = getWidgets(tr.state);

		// 既存の display math widget は rebuild により新しいインスタンスに置き換わる。
		expect(after).toHaveLength(1);
		expect(after[0].widget).not.toBe(originalWidget);
		// 挿入した単体の $ 自体は閉じ引用符がなくマッチしないが、
		// 既存の $$disp$$ の walk が candidates に再度含まれることを確認する。
		expect(candidateCount(tr.state)).toBeGreaterThanOrEqual(originalCandidateCount);
	});

	it("既存の数式範囲内部を編集すると full rebuild が走る", () => {
		const doc = "text\n\n$$disp$$\n\nmore text";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;
		const mathFrom = before[0].from;

		// "disp" の中身を書き換える (math 範囲の内部編集)。
		const insertPos = mathFrom + 3; // "$$d|isp$$"
		const tr = state.update({ changes: { from: insertPos, to: insertPos, insert: "X" } });
		const after = getWidgets(tr.state);

		expect(after).toHaveLength(1);
		expect(after[0].widget).not.toBe(originalWidget);
	});

	it("既存の数式範囲の隣接行 (±1 行) を編集すると full rebuild が走る", () => {
		const doc = "text\n\n$$disp$$\n\nmore text";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;

		// math の直前の空行 (line2) に挿入する。
		const line2From = state.doc.line(2).from;
		const tr = state.update({ changes: { from: line2From, to: line2From, insert: "y" } });
		const after = getWidgets(tr.state);

		expect(after).toHaveLength(1);
		expect(after[0].widget).not.toBe(originalWidget);
	});

	it("数式のない行から別の数式のない行へカーソル移動しても rebuild しない", () => {
		const doc = "line one\n\n$$disp$$\n\nline five";
		const state = makeState(doc, EditorSelection.single(0));
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;

		// line1 → line5、どちらも math の pad 範囲 (line2..line4) に含まれない。
		const line5From = state.doc.line(5).from;
		const tr = state.update({ selection: EditorSelection.cursor(line5From) });
		const after = getWidgets(tr.state);

		expect(after).toHaveLength(1);
		expect(after[0].widget).toBe(originalWidget);
	});

	it("数式行へカーソルが出入りすると rebuild する (widget 表示⇔ソース表示の切替に必要)", () => {
		const doc = "line one\n\n$$disp$$\n\nline five";
		const state = makeState(doc, EditorSelection.single(0));
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;

		const mathLineFrom = state.doc.line(3).from;
		const tr = state.update({ selection: EditorSelection.cursor(mathLineFrom) });
		const after = getWidgets(tr.state);

		// hasFocus は field 作成時点で false のまま (queueMicrotask 経由の focus effect は
		// EditorView なしでは発火しない) なので、cursorLines 自体は空集合のまま widget は
		// 引き続き描画される。ここで検証したいのは「rebuild が起きたか」であり、
		// widget 参照の入れ替わりで判定する。
		expect(after).toHaveLength(1);
		expect(after[0].widget).not.toBe(originalWidget);
	});

	it("削除で $ が消えるケース (削除範囲の旧テキスト判定) では full rebuild が走る", () => {
		const doc = "text\n\n$$disp$$\n\nmore text";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const mathTo = before[0].to;

		// math 自身の閉じ "$$" を削除 (display math が壊れる編集)。
		const tr = state.update({ changes: { from: mathTo - 2, to: mathTo, insert: "" } });
		const after = getWidgets(tr.state);

		// display math の閉じが壊れるため widget 自体は消える (別内容として rebuild)。
		expect(after).toHaveLength(0);
	});

	it("CRLF 改行を含む挿入・削除でも行判定が正しく機能する (改行前後の row 判定漏れ防止)", () => {
		const doc = "text\r\n\r\n$$disp$$\r\n\r\nmore text";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;
		const originalFrom = before[0].from;
		const originalTo = before[0].to;

		// 遠い行 (先頭) への非 $ 挿入 → skip path、CRLF でも位置 map が正しいことを確認。
		const tr1 = state.update({ changes: { from: 0, to: 0, insert: "zzzz" } });
		const after1 = getWidgets(tr1.state);
		expect(after1).toHaveLength(1);
		expect(after1[0].widget).toBe(originalWidget);
		expect(after1[0].from).toBe(originalFrom + 4);
		expect(after1[0].to).toBe(originalTo + 4);

		// math の隣接行 (直前の空行) への挿入 → CRLF 環境でも rebuild が正しく検知される。
		const line2From = tr1.state.doc.line(2).from;
		const tr2 = tr1.state.update({ changes: { from: line2From, to: line2From, insert: "w" } });
		const after2 = getWidgets(tr2.state);
		expect(after2).toHaveLength(1);
		expect(after2[0].widget).not.toBe(after1[0].widget);
	});

	it("IME composition 中でも判定は同一 (math の StateField は ViewUpdate.composing を参照しない)", () => {
		// mathDecorationField.update() のシグネチャは (value, tr: Transaction) であり、
		// composing 状態を持つ ViewUpdate を経由しない。handleComposingUpdate (plugin-utils.ts)
		// は ViewPlugin 向けのヘルパーで、StateField ベースの mathDecorationField では
		// そもそも使用していない (mathFocusHandler など他の ViewPlugin でも math では未使用)。
		// そのため IME composing 中かどうかで docChanged 時の rebuild / skip 判定が変わることは
		// 構造的にあり得ない。ここでは通常の docChanged と同じ判定が単に適用されることを
		// 再確認する (композing 有無で分岐する実装ではないため専用の composing テストは
		// 意味を持たない)。
		const doc = "hello world\n\n$$disp$$\n\nafter math text";
		const state = makeState(doc);
		const before = getWidgets(state);
		const tr = state.update({ changes: { from: 0, to: 0, insert: "zzz" } });
		const after = getWidgets(tr.state);
		expect(after[0].widget).toBe(before[0].widget);
	});

	it("undo 相当の複合 changes (compound transaction) でも rebuild 判定が正しく機能する", () => {
		const doc = "hello world\n\n$$disp$$\n\nafter math text";
		const state = makeState(doc);
		const before = getWidgets(state);
		expect(before).toHaveLength(1);
		const originalWidget = before[0].widget;

		// 1 つの transaction 内に「math と無関係な遠隔地の編集」+「$ を含む編集」を複合させる
		// (undo が生成する compound ChangeSet を模擬)。
		const tr = state.update({
			changes: [
				{ from: 0, to: 0, insert: "zzzz" },
				{ from: state.doc.length, to: state.doc.length, insert: " $" },
			],
		});
		const after = getWidgets(tr.state);

		expect(after).toHaveLength(1);
		expect(after[0].widget).not.toBe(originalWidget);
	});
});
