import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { collectCursorLines } from "./cursor-utils";
import { createTestState } from "./test-helper";

describe("collectCursorLines", () => {
	const doc = "line1\nline2\nline3\nline4\nline5";

	it("空セレクション（カーソル）ではカーソル行を返す", () => {
		const state = createTestState(doc, 0); // line 1
		const lines = collectCursorLines(state, true);
		expect(lines).toEqual(new Set([1]));
	});

	it("フォーカスなしの場合は空集合を返す", () => {
		const state = createTestState(doc, 0);
		const lines = collectCursorLines(state, false);
		expect(lines).toEqual(new Set());
	});

	it("範囲セレクションでは anchor 行のみ返す（from→to 方向）", () => {
		// anchor=0 (line1), head=17 (line3) → anchor 行 (1) のみ
		const selection = EditorSelection.create([EditorSelection.range(0, 17)]);
		const state = createTestState(doc, undefined, undefined, selection);
		const lines = collectCursorLines(state, true);
		expect(lines).toEqual(new Set([1]));
	});

	it("範囲セレクションでは anchor 行のみ返す（to→from 方向）", () => {
		// anchor=17 (line3), head=0 (line1) → anchor 行 (3) のみ
		const selection = EditorSelection.create([EditorSelection.range(17, 0)]);
		const state = createTestState(doc, undefined, undefined, selection);
		const lines = collectCursorLines(state, true);
		expect(lines).toEqual(new Set([3]));
	});

	it("複数カーソルでは各カーソル行を返す", () => {
		const selection = EditorSelection.create([
			EditorSelection.cursor(0),
			EditorSelection.cursor(18),
		]);
		const state = createTestState(
			doc,
			undefined,
			EditorState.allowMultipleSelections.of(true),
			selection,
		);
		const lines = collectCursorLines(state, true);
		expect(lines).toEqual(new Set([1, 4]));
	});

	it("全選択では anchor 行のみ返す（全行を返さない）", () => {
		// anchor=0 (line1), head=end → anchor 行 (1) のみ
		const selection = EditorSelection.create([EditorSelection.range(0, doc.length)]);
		const state = createTestState(doc, undefined, undefined, selection);
		const lines = collectCursorLines(state, true);
		expect(lines).toEqual(new Set([1]));
	});
});
