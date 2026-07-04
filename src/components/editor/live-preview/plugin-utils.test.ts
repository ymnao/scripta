import { ChangeSet } from "@codemirror/state";
import { Decoration, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { handleComposingUpdate, iterateVisibleSyntax } from "./plugin-utils";
import { createMockView, createTestState } from "./test-helper";

describe("iterateVisibleSyntax", () => {
	it("visits nodes inside visibleRanges only", () => {
		const doc = "# heading1\n\ntext\n\n# heading2";
		const state = createTestState(doc);
		const headingIdx1 = doc.indexOf("# heading1");
		const headingIdx2 = doc.indexOf("# heading2");
		// visibleRanges を heading2 の範囲だけに絞る
		const view = createMockView(state, [{ from: headingIdx2, to: doc.length }]);

		const visited: string[] = [];
		iterateVisibleSyntax(view, (node) => {
			if (node.name.startsWith("ATXHeading")) {
				visited.push(state.doc.sliceString(node.from, node.to));
			}
		});

		expect(visited).toEqual(["# heading2"]);
		expect(visited).not.toContain(state.doc.sliceString(headingIdx1, headingIdx1 + 10));
	});

	it("iterates over multiple visibleRanges", () => {
		const doc = "# a\n\n# b\n\n# c\n\n# d";
		const state = createTestState(doc);
		const a = doc.indexOf("# a");
		const b = doc.indexOf("# b");
		const d = doc.indexOf("# d");
		// # a と # d の範囲だけ visible
		const view = createMockView(state, [
			{ from: a, to: b - 1 },
			{ from: d, to: doc.length },
		]);

		const visited: string[] = [];
		iterateVisibleSyntax(view, (node) => {
			if (node.name.startsWith("ATXHeading")) {
				visited.push(state.doc.sliceString(node.from, node.to));
			}
		});

		expect(visited).toEqual(["# a", "# d"]);
		expect(visited).not.toContain("# b");
		expect(visited).not.toContain("# c");
	});

	it("respects `false` return to skip descendants", () => {
		const doc = "> **bold quote**";
		const state = createTestState(doc);
		const view = createMockView(state);

		const namesEnter: string[] = [];
		iterateVisibleSyntax(view, (node) => {
			namesEnter.push(node.name);
			// Blockquote の中身を全部スキップ
			if (node.name === "Blockquote") return false;
		});

		// Blockquote には入るが、その子孫 (Paragraph, StrongEmphasis, 等) には
		// 入らないはず
		expect(namesEnter).toContain("Blockquote");
		expect(namesEnter).not.toContain("StrongEmphasis");
	});

	it("passes tree/from/to context to callback", () => {
		const doc = "hello world";
		const state = createTestState(doc);
		const view = createMockView(state, [{ from: 0, to: doc.length }]);

		// closure での代入は control flow narrowing で never 化されるため、
		// array に push する形で narrowing を回避する
		const captured: { tree: unknown; from: number; to: number }[] = [];
		iterateVisibleSyntax(view, (node, ctx) => {
			if (node.name === "Document") {
				captured.push({ tree: ctx.tree, from: ctx.from, to: ctx.to });
			}
		});

		expect(captured).toHaveLength(1);
		expect(captured[0].from).toBe(0);
		expect(captured[0].to).toBe(doc.length);
		expect(captured[0].tree).toBeDefined();
	});
});

// 最低限の ViewUpdate を組み立てる。composing / docChanged / changes だけ設定する。
function createMockUpdate(opts: {
	composing: boolean;
	docChanged: boolean;
	changes?: ChangeSet;
}): ViewUpdate {
	const changes = opts.changes ?? ChangeSet.empty(0);
	return {
		view: { composing: opts.composing },
		docChanged: opts.docChanged,
		changes,
	} as unknown as ViewUpdate;
}

describe("handleComposingUpdate", () => {
	const doc = "hello";
	const initialDecorations: DecorationSet = Decoration.set(
		[Decoration.mark({ class: "cm-test" }).range(0, doc.length)],
		true,
	);

	it("returns false when not composing", () => {
		const target = { decorations: initialDecorations };
		const update = createMockUpdate({ composing: false, docChanged: false });
		expect(handleComposingUpdate(update, target)).toBe(false);
		expect(target.decorations).toBe(initialDecorations);
	});

	it("returns true and leaves decorations untouched when composing without doc change", () => {
		const target = { decorations: initialDecorations };
		const update = createMockUpdate({ composing: true, docChanged: false });
		expect(handleComposingUpdate(update, target)).toBe(true);
		expect(target.decorations).toBe(initialDecorations);
	});

	it("maps decorations when composing with doc change", () => {
		// "hello" の先頭に "X" を insert する change → 元のデコレーション range が 1 shift される
		const changes = ChangeSet.of({ from: 0, insert: "X" }, doc.length);
		const target = { decorations: initialDecorations };
		const update = createMockUpdate({ composing: true, docChanged: true, changes });

		expect(handleComposingUpdate(update, target)).toBe(true);
		expect(target.decorations).not.toBe(initialDecorations);

		// map された後の decoration は from が 1 shift されているはず
		const iter = target.decorations.iter();
		expect(iter.value).not.toBeNull();
		expect(iter.from).toBe(1);
	});

	it("also maps atomicRanges when target has it", () => {
		const initialAtomic: DecorationSet = Decoration.set(
			[Decoration.mark({ class: "cm-atomic" }).range(0, 3)],
			true,
		);
		const changes = ChangeSet.of({ from: 0, insert: "X" }, doc.length);
		const target: { decorations: DecorationSet; atomicRanges: DecorationSet } = {
			decorations: initialDecorations,
			atomicRanges: initialAtomic,
		};
		const update = createMockUpdate({ composing: true, docChanged: true, changes });

		expect(handleComposingUpdate(update, target)).toBe(true);
		expect(target.decorations).not.toBe(initialDecorations);
		expect(target.atomicRanges).not.toBe(initialAtomic);

		const atomicIter = target.atomicRanges.iter();
		expect(atomicIter.from).toBe(1);
	});
});
