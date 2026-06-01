import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyTable } from "./table-utils";
import { insertTable, tableKeymap } from "./tables";
import { createTestState } from "./test-helper";

describe("tableKeymap", () => {
	it("Extension として定義されている", () => {
		expect(tableKeymap).toBeDefined();
	});
});

// ── insertTable / Mod-Shift-T （#88 / #90 part1） ──
//
// insertTable は dispatch を伴うため real EditorView を jsdom 上で起動して検証する
// （horizontal-rules.test.ts の runtime テストと同じ方針）。

const isMac = typeof navigator !== "undefined" && navigator.platform.includes("Mac");

describe("insertTable (runtime)", () => {
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
			extensions: [markdown({ base: markdownLanguage }), tableKeymap],
		});
		ensureSyntaxTree(state, state.doc.length, Number.POSITIVE_INFINITY);
		state = state.update({}).state;
		const view = new EditorView({ state, parent });
		view.focus();
		mounted.push(view);
		return view;
	}

	/** ドキュメント末尾（テーブル直下）に編集可能な行があることを確認する。 */
	function lastLineIsBlank(view: EditorView): boolean {
		const { doc } = view.state;
		return doc.line(doc.lines).text.trim().length === 0;
	}

	it("空ドキュメントに挿入するとテーブル直下に行ができる（改行 1 つだけ）", () => {
		const view = mountEditor("", 0);
		insertTable(view);
		const text = view.state.doc.toString();
		// 末尾は単一の改行（余分な空行 \n\n を作らない）
		expect(text).toBe(`${createEmptyTable(3, 2)}\n`);
		expect(lastLineIsBlank(view)).toBe(true);
	});

	it("本文行の直後に挿入され、テーブル直下に行ができる", () => {
		const view = mountEditor("hello", 5);
		insertTable(view);
		const text = view.state.doc.toString();
		expect(text).toBe(`hello\n${createEmptyTable(3, 2)}\n`);
		expect(lastLineIsBlank(view)).toBe(true);
	});

	it("既に直下に行がある場合は改行を二重に追加しない（idempotent）", () => {
		// "hello\n\n" の空行（line2）にカーソル
		const view = mountEditor("hello\n\n", 6);
		insertTable(view);
		const text = view.state.doc.toString();
		// テーブル直下の行は 1 つだけ（\n\n にならない）
		expect(text).toBe(`hello\n${createEmptyTable(3, 2)}\n`);
	});

	it("Mod-Shift-T でテーブルが挿入される", () => {
		const view = mountEditor("", 0);
		// CM のキーマッチングは base key（小文字 "t"）+ Shift 修飾で解決する
		const event = new KeyboardEvent("keydown", {
			key: "t",
			code: "KeyT",
			shiftKey: true,
			ctrlKey: !isMac,
			metaKey: isMac,
		});
		const handled = runScopeHandlers(view, event, "editor");
		expect(handled).toBe(true);
		expect(view.state.doc.toString().startsWith("| ")).toBe(true);
	});
});

describe("createEmptyTable", () => {
	it("指定した列数・行数のテーブルテンプレートを生成する", () => {
		const table = createEmptyTable(3, 2);
		const lines = table.split("\n");
		// header + delimiter + 2 data rows = 4 lines
		expect(lines.length).toBe(4);
		// Each line should have 3 columns (4 pipes)
		for (const line of lines) {
			expect(line.split("|").length - 1).toBeGreaterThanOrEqual(4);
		}
	});
});

describe("findTableNodeAt (via syntaxTree)", () => {
	it("テーブルの開始行で Table ノードが見つかる", () => {
		const doc = "text\n\n| A | B |\n| --- | --- |\n| 1 | 2 |";
		const state = createTestState(doc);
		ensureSyntaxTree(state, state.doc.length, 5000);
		const tree = syntaxTree(state);
		const lineFrom = state.doc.line(3).from;
		let node = tree.resolve(lineFrom, 1);
		let found = false;
		while (node) {
			if (node.name === "Table") {
				found = true;
				break;
			}
			if (!node.parent) break;
			node = node.parent;
		}
		expect(found).toBe(true);
	});

	it("テーブルでない行では Table ノードが見つからない", () => {
		const doc = "Hello\n\nWorld";
		const state = createTestState(doc);
		ensureSyntaxTree(state, state.doc.length, 5000);
		const tree = syntaxTree(state);
		const lineFrom = state.doc.line(1).from;
		let node = tree.resolve(lineFrom, 1);
		let found = false;
		while (node) {
			if (node.name === "Table") {
				found = true;
				break;
			}
			if (!node.parent) break;
			node = node.parent;
		}
		expect(found).toBe(false);
	});

	it("テーブル隣接行は Table ノードではない", () => {
		const doc = "above\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nbelow";
		const state = createTestState(doc);
		ensureSyntaxTree(state, state.doc.length, 5000);
		const tree = syntaxTree(state);

		// "above" line (line 1) should NOT be a Table node
		const aboveFrom = state.doc.line(1).from;
		let node = tree.resolve(aboveFrom, 1);
		let found = false;
		while (node) {
			if (node.name === "Table") {
				found = true;
				break;
			}
			if (!node.parent) break;
			node = node.parent;
		}
		expect(found).toBe(false);

		// "below" line should NOT be a Table node
		const belowLine = state.doc.line(state.doc.lines);
		node = tree.resolve(belowLine.from, 1);
		found = false;
		while (node) {
			if (node.name === "Table") {
				found = true;
				break;
			}
			if (!node.parent) break;
			node = node.parent;
		}
		expect(found).toBe(false);
	});
});
