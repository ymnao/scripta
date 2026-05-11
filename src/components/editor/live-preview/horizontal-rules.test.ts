import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { buildDecorations, HRWidget, horizontalRuleDecoration } from "./horizontal-rules";
import {
	collectDecorations,
	createViewForTest,
	replaceDecorations,
	widgetDecorations,
} from "./test-helper";

describe("HRWidget", () => {
	it("eq() returns true for any HRWidget", () => {
		const a = new HRWidget();
		const b = new HRWidget();
		expect(a.eq(b)).toBe(true);
	});

	it("toDOM() creates an hr element with cm-hr-widget class", () => {
		const widget = new HRWidget();
		const el = widget.toDOM();
		expect(el.tagName).toBe("HR");
		expect(el.className).toBe("cm-hr-widget");
	});

	it("ignoreEvent() returns true", () => {
		const widget = new HRWidget();
		expect(widget.ignoreEvent()).toBe(true);
	});
});

describe("buildDecorations", () => {
	it("creates a replace+widget decoration for ---", () => {
		const view = createViewForTest("text\n\n---");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
		expect(replaceDecorations(decos)).toHaveLength(1);
	});

	it("creates a decoration for ***", () => {
		const view = createViewForTest("text\n\n***");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
	});

	it("creates a decoration for ___", () => {
		const view = createViewForTest("text\n\n___");
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
	});

	it("handles multiple HRs", () => {
		const doc = "text\n\n---\n\n***\n\n___";
		const view = createViewForTest(doc, doc.indexOf("text"));
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(3);
	});

	it("skips decoration when cursor is on HR line", () => {
		const doc = "text\n\n---";
		const hrPos = doc.indexOf("---");
		const view = createViewForTest(doc, hrPos);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(0);
	});

	it("keeps decoration when focused but cursor is on a different line", () => {
		const doc = "text\n\n---";
		const view = createViewForTest(doc, doc.indexOf("text"));
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
	});

	it("keeps decoration when editor is unfocused even with cursor on HR line", () => {
		const doc = "text\n\n---";
		const hrPos = doc.indexOf("---");
		const view = createViewForTest(doc, hrPos, undefined, false);
		const decos = collectDecorations(buildDecorations(view));
		const widgets = widgetDecorations(decos);
		expect(widgets).toHaveLength(1);
	});

	it("returns empty set for document without HRs", () => {
		const view = createViewForTest("hello world\n\nno rules here");
		const decos = collectDecorations(buildDecorations(view));
		expect(decos).toHaveLength(0);
	});
});

// `buildDecorations` の純粋関数テストはカーソル位置と focus 状態を切り替えた
// snapshot しか検証しない。本 PR の本質はカーソル移動 / focus 変化を契機に
// `update()` が selectionSet / focusChanged を見て decoration を貼り直す
// runtime 経路。real EditorView を jsdom 上で起動し、dispatch / blur で
// その経路を直接担保する。
describe("horizontalRuleDecoration (runtime update)", () => {
	const mounted: EditorView[] = [];

	afterEach(() => {
		while (mounted.length > 0) {
			mounted.pop()?.destroy();
		}
	});

	function mountEditor(doc: string, cursorPos: number): EditorView {
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		let state = EditorState.create({
			doc,
			selection: EditorSelection.cursor(cursorPos),
			extensions: [markdown({ base: markdownLanguage }), horizontalRuleDecoration],
		});
		ensureSyntaxTree(state, state.doc.length, Number.POSITIVE_INFINITY);
		state = state.update({}).state;
		const view = new EditorView({ state, parent });
		view.focus();
		mounted.push(view);
		return view;
	}

	function widgetCount(view: EditorView): number {
		const plugin = view.plugin(horizontalRuleDecoration);
		if (!plugin) return 0;
		return widgetDecorations(collectDecorations(plugin.decorations)).length;
	}

	it("removes decoration when cursor moves onto HR line", () => {
		const doc = "text\n\n---";
		const view = mountEditor(doc, 0);
		// 初回の selectionSet で focus 取得後の cursorLines に同期される。
		view.dispatch({ selection: EditorSelection.cursor(0) });
		expect(widgetCount(view)).toBe(1);

		view.dispatch({ selection: EditorSelection.cursor(doc.indexOf("---")) });
		expect(widgetCount(view)).toBe(0);
	});

	it("restores decoration when cursor moves off HR line", () => {
		const doc = "text\n\n---";
		const hrPos = doc.indexOf("---");
		const view = mountEditor(doc, hrPos);
		view.dispatch({ selection: EditorSelection.cursor(hrPos) });
		expect(widgetCount(view)).toBe(0);

		view.dispatch({ selection: EditorSelection.cursor(0) });
		expect(widgetCount(view)).toBe(1);
	});

	it("restores decoration when editor loses focus on HR line", () => {
		const doc = "text\n\n---";
		const hrPos = doc.indexOf("---");
		const view = mountEditor(doc, hrPos);
		view.dispatch({ selection: EditorSelection.cursor(hrPos) });
		expect(widgetCount(view)).toBe(0);

		// jsdom 上では `contentDOM.blur()` 後の focus 状態を CM が plugin に伝える
		// タイミングが measure cycle に依存し flaky になる。後続トランザクションを
		// dispatch して plugin の update() を明示的に走らせる（focusChanged /
		// selectionSet どちらの経路でも cursorLinesChanged 判定の同一分岐に到達するため、
		// focus 喪失が decoration 復帰に反映されることを runtime で担保できる）。
		view.contentDOM.blur();
		view.dispatch({ selection: EditorSelection.cursor(hrPos) });
		expect(widgetCount(view)).toBe(1);
	});
});
