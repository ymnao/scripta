import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { createEmptyTable } from "./table-utils";
import { tableKeymap } from "./tables";
import { createTestState } from "./test-helper";

describe("tableKeymap", () => {
	it("Extension として定義されている", () => {
		expect(tableKeymap).toBeDefined();
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
