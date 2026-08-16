import type { DecorationSet, EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { buildDecorations, emphasisDecoration } from "./emphasis";
import {
	cleanupMountedViews,
	collectDecorations,
	createViewForTest,
	markDecorations,
	mountEditorView,
	replaceDecorations,
} from "./test-helper";

function markClasses(view: EditorView): string[] {
	return markDecorations(collectDecorations(buildDecorations(view))).map(
		(d) => (d.value.spec as { class: string }).class,
	);
}

describe("buildDecorations", () => {
	it("hides EmphasisMark and applies cm-emphasis class", () => {
		const doc = "text\n\n*em*";
		const view = createViewForTest(doc);
		const decos = collectDecorations(buildDecorations(view));
		const marks = markDecorations(decos);
		// 2 replace for the * markers + 1 mark for the content = 3
		expect(decos).toHaveLength(3);
		expect(marks).toHaveLength(1);
		expect((marks[0].value.spec as { class: string }).class).toBe("cm-emphasis");
		expect(marks[0].from).toBe(doc.indexOf("em"));
		expect(marks[0].to).toBe(doc.indexOf("em") + 2);
	});

	it("applies cm-strong class to StrongEmphasis", () => {
		expect(markClasses(createViewForTest("text\n\n**bold**"))).toEqual(["cm-strong"]);
	});

	it("hides both two-character markers of StrongEmphasis", () => {
		const doc = "text\n\n**bold**";
		const replaces = replaceDecorations(
			collectDecorations(buildDecorations(createViewForTest(doc))),
		).filter((d) => (d.value.spec as { class?: string }).class == null);
		expect(replaces.map((d) => [d.from, d.to])).toEqual([
			[doc.indexOf("**"), doc.indexOf("**") + 2],
			[doc.length - 2, doc.length],
		]);
	});

	it("decorates nested emphasis inside strong emphasis", () => {
		expect(markClasses(createViewForTest("text\n\n**bold *em* tail**"))).toEqual([
			"cm-strong",
			"cm-emphasis",
		]);
	});

	it("skips emphasis on the cursor line", () => {
		const doc = "text\n\n*em*";
		const view = createViewForTest(doc, doc.indexOf("em"));
		expect(collectDecorations(buildDecorations(view))).toHaveLength(0);
	});

	it("keeps emphasis on other lines while the cursor sits on one of them", () => {
		const doc = "*one*\n\n*two*";
		const view = createViewForTest(doc, doc.indexOf("two"));
		const marks = markDecorations(collectDecorations(buildDecorations(view)));
		expect(marks).toHaveLength(1);
		expect(marks[0].from).toBe(doc.indexOf("one"));
	});

	it("skips a multi-line emphasis when the cursor is on its closing line", () => {
		const doc = "text\n\n*spans\ntwo lines*";
		const view = createViewForTest(doc, doc.indexOf("two lines"));
		expect(collectDecorations(buildDecorations(view))).toHaveLength(0);
	});

	it("ignores emphasis outside the visible ranges", () => {
		const doc = "*one*\n\n*two*";
		const twoFrom = doc.indexOf("*two*");
		const view = createViewForTest(doc, undefined, [{ from: twoFrom, to: doc.length }]);
		const marks = markDecorations(collectDecorations(buildDecorations(view)));
		expect(marks).toHaveLength(1);
		expect(marks[0].from).toBe(doc.indexOf("two"));
	});

	it("returns an empty set for a document without emphasis", () => {
		expect(collectDecorations(buildDecorations(createViewForTest("plain text")))).toHaveLength(0);
	});
});

describe("emphasisDecoration update gate (real EditorView)", () => {
	afterEach(cleanupMountedViews);

	const DOC = "text\n\n*em* and **bold**";

	function pluginDecorations(v: EditorView): DecorationSet {
		const plugin = v.plugin(emphasisDecoration);
		if (!plugin) throw new Error("emphasisDecoration plugin not mounted");
		return plugin.decorations;
	}

	function renderedClasses(v: EditorView): string[] {
		return Array.from(v.contentDOM.querySelectorAll(".cm-emphasis, .cm-strong")).map(
			(el) => el.className,
		);
	}

	it("renders emphasis markup with the markers hidden", () => {
		const v = mountEditorView(DOC, emphasisDecoration);
		expect(renderedClasses(v)).toEqual(["cm-emphasis", "cm-strong"]);
		expect(v.contentDOM.textContent).toBe("textem and bold");
	});

	// forceRebuild の 3 disjunct (docChanged / viewportChanged / syntax tree 差し替え) は
	// このテストでは分離できない。jsdom では doc への挿入が viewportChanged も必ず立てる
	// ため、どれか 1 つ (あるいは docChanged と tree 比較の 2 つ) を消しても pass する。
	// 観測できるのは「doc 変更後に装飾が現れる」という gate 全体の性質だけ。
	it("rebuilds decorations after a document change introduces emphasis", () => {
		const v = mountEditorView("text", emphasisDecoration);
		expect(renderedClasses(v)).toEqual([]);

		v.dispatch({ changes: { from: v.state.doc.length, insert: "\n\n*added*" } });

		expect(renderedClasses(v)).toEqual(["cm-emphasis"]);
	});

	function mountFocused(): EditorView {
		const v = mountEditorView(DOC, emphasisDecoration);
		v.focus();
		// collectCursorLines は hasFocus が false だと常に空集合を返す。focus が入らないと
		// 以下のテストはどれも「カーソル行なし」の同一シナリオへ退化し、うち再構築されない
		// 側の検証は vacuous pass になるため、focus が入ったことをここで固定する。
		expect(v.hasFocus).toBe(true);
		return v;
	}

	it("drops the decorations of the line the cursor moves onto and restores them on leaving", () => {
		const v = mountFocused();

		v.dispatch({ selection: { anchor: DOC.indexOf("em") } });
		expect(renderedClasses(v)).toEqual([]);

		v.dispatch({ selection: { anchor: 0 } });
		expect(renderedClasses(v)).toEqual(["cm-emphasis", "cm-strong"]);
	});

	it("does not rebuild when the selection moves within the same line", () => {
		const v = mountFocused();

		v.dispatch({ selection: { anchor: 0 } });
		const before = pluginDecorations(v);
		// 空の DecorationSet は Decoration.none シングルトンなので、装飾が 0 件だと
		// 再構築の有無に関わらず identity が一致してしまう。非空をここで固定する。
		expect(renderedClasses(v)).toEqual(["cm-emphasis", "cm-strong"]);
		v.dispatch({ selection: { anchor: 1 } });

		// 装飾内容は再構築されても同一なので、DOM も DecorationSet の中身も差が出ない。
		// 再構築が走ったかどうかは buildDecorations が返す新しい object の identity
		// でしか観測できない。
		expect(pluginDecorations(v)).toBe(before);
	});

	it("rebuilds when the selection moves to another line", () => {
		const v = mountFocused();

		v.dispatch({ selection: { anchor: 0 } });
		const before = pluginDecorations(v);
		v.dispatch({ selection: { anchor: DOC.indexOf("em") } });

		expect(pluginDecorations(v)).not.toBe(before);
	});
});
