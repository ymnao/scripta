import { describe, expect, it } from "vitest";
import {
	createEmptyTable,
	escapeTableCell,
	findTableAt,
	findUnescapedPipe,
	formatTable,
	getCellAt,
	getNextCell,
	getPrevCell,
} from "./table-utils";
import { createTestState } from "./test-helper";

function makeState(doc: string, cursorPos?: number) {
	return createTestState(doc, cursorPos);
}

const simpleTable = `| A | B | C |
| --- | --- | --- |
| 1 | 2 | 3 |
| 4 | 5 | 6 |`;

describe("findTableAt", () => {
	it("シンプルなテーブルを正しく解析する", () => {
		const state = makeState(simpleTable);
		const table = findTableAt(state, 2);
		expect(table).not.toBeNull();
		if (!table) return;

		expect(table.rows).toHaveLength(4);
		expect(table.rows[0].kind).toBe("header");
		expect(table.rows[1].kind).toBe("delimiter");
		expect(table.rows[2].kind).toBe("data");
		expect(table.rows[3].kind).toBe("data");
	});

	it("ヘッダー行のセルを正しく解析する", () => {
		const state = makeState(simpleTable);
		const table = findTableAt(state, 2);
		if (!table) return;

		expect(table.rows[0].cells).toHaveLength(3);
		expect(table.rows[0].cells[0].content).toBe("A");
		expect(table.rows[0].cells[1].content).toBe("B");
		expect(table.rows[0].cells[2].content).toBe("C");
	});

	it("テーブル外ではnullを返す", () => {
		const state = makeState(`Hello\n\n${simpleTable}\n\nWorld`);
		const table = findTableAt(state, 0);
		expect(table).toBeNull();
	});
});

describe("getCellAt", () => {
	it("カーソル位置からセル座標を取得する", () => {
		const state = makeState(simpleTable);
		const table = findTableAt(state, 2);
		if (!table) return;

		const coord = getCellAt(table, 2);
		expect(coord).toEqual({ row: 0, col: 0, cell: table.rows[0].cells[0] });
	});

	it("2番目のセルの座標を取得する", () => {
		const state = makeState(simpleTable);
		const table = findTableAt(state, 2);
		if (!table) return;

		const coord = getCellAt(table, 6);
		expect(coord).toEqual({ row: 0, col: 1, cell: table.rows[0].cells[1] });
	});
});

describe("getNextCell / getPrevCell", () => {
	it("次のセルに移動する", () => {
		const state = makeState(simpleTable);
		const table = findTableAt(state, 2);
		if (!table) return;

		const next = getNextCell(table, { row: 0, col: 0, cell: table.rows[0].cells[0] });
		expect(next).not.toBeNull();
		expect(next?.col).toBe(1);
		expect(next?.row).toBe(0);
	});

	it("行末から次の行に移動する（デリミタ行をスキップ）", () => {
		const state = makeState(simpleTable);
		const table = findTableAt(state, 2);
		if (!table) return;

		const next = getNextCell(table, { row: 0, col: 2, cell: table.rows[0].cells[2] });
		expect(next).not.toBeNull();
		expect(next?.row).toBe(2);
		expect(next?.col).toBe(0);
	});

	it("前のセルに移動する", () => {
		const state = makeState(simpleTable);
		const table = findTableAt(state, 2);
		if (!table) return;

		const prev = getPrevCell(table, { row: 0, col: 1, cell: table.rows[0].cells[1] });
		expect(prev).not.toBeNull();
		expect(prev?.col).toBe(0);
		expect(prev?.row).toBe(0);
	});

	it("行頭から前の行に移動する（デリミタ行をスキップ）", () => {
		const state = makeState(simpleTable);
		const table = findTableAt(state, 2);
		if (!table) return;

		const prev = getPrevCell(table, { row: 2, col: 0, cell: table.rows[2].cells[0] });
		expect(prev).not.toBeNull();
		expect(prev?.row).toBe(0);
		expect(prev?.col).toBe(2);
	});

	it("最後のセルの次はnull", () => {
		const state = makeState(simpleTable);
		const table = findTableAt(state, 2);
		if (!table) return;

		const next = getNextCell(table, { row: 3, col: 2, cell: table.rows[3].cells[2] });
		expect(next).toBeNull();
	});

	it("最初のセルの前はnull", () => {
		const state = makeState(simpleTable);
		const table = findTableAt(state, 2);
		if (!table) return;

		const prev = getPrevCell(table, { row: 0, col: 0, cell: table.rows[0].cells[0] });
		expect(prev).toBeNull();
	});
});

describe("formatTable", () => {
	it("列幅を揃える", () => {
		const unaligned = `| A | BB | CCC |
| --- | --- | --- |
| long content | x | y |`;
		const state = makeState(unaligned);
		const table = findTableAt(state, 2);
		if (!table) return;

		const formatted = formatTable(table, state);
		const lines = formatted.split("\n");
		expect(lines[0]).toBe("| A            | BB  | CCC |");
		expect(lines[1]).toBe("| ------------ | --- | --- |");
		expect(lines[2]).toBe("| long content | x   | y   |");
	});

	it("全角文字の幅を考慮する", () => {
		const table = `| 名前 | Age |
| --- | --- |
| 太郎 | 20 |`;
		const state = makeState(table);
		const t = findTableAt(state, 2);
		if (!t) return;

		const formatted = formatTable(t, state);
		const lines = formatted.split("\n");
		expect(lines[0]).toBe("| 名前 | Age |");
		expect(lines[1]).toBe("| ---- | --- |");
		expect(lines[2]).toBe("| 太郎 | 20  |");
	});

	it("アライメントマーカーを保持する", () => {
		const table = `| Left | Center | Right |
| :--- | :---: | ---: |
| a | b | c |`;
		const state = makeState(table);
		const t = findTableAt(state, 2);
		if (!t) return;

		const formatted = formatTable(t, state);
		const lines = formatted.split("\n");
		expect(lines[0]).toBe("| Left | Center | Right |");
		expect(lines[1]).toBe("| ---- | :----: | ----: |");
		expect(lines[2]).toBe("| a    | b      | c     |");
	});
});

describe("createEmptyTable", () => {
	it("指定サイズの空テーブルを生成する", () => {
		const table = createEmptyTable(3, 2);
		const lines = table.split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[1]).toContain("-----");
	});

	it("各行のパイプ数が一致する", () => {
		const table = createEmptyTable(2, 1);
		const lines = table.split("\n");
		for (const line of lines) {
			const pipeCount = (line.match(/\|/g) || []).length;
			expect(pipeCount).toBe(3);
		}
	});
});

describe("escapeTableCell", () => {
	it("素朴なテキストはそのまま返す", () => {
		expect(escapeTableCell("hello")).toBe("hello");
	});

	it("`|` を `\\|` にエスケープする", () => {
		expect(escapeTableCell("a|b")).toBe("a\\|b");
	});

	it("`\\` を `\\\\` に倍化する", () => {
		expect(escapeTableCell("a\\b")).toBe("a\\\\b");
	});

	it("`\\` + `|` は `|` 直前の `\\` 個数が奇数になるようエスケープする", () => {
		// 入力 `a\|b` (a, \, |, b) → 出力 `a\\\|b` (a, \, \, \, |, b) = 3 個 (奇数)
		const out = escapeTableCell("a\\|b");
		expect(out).toBe("a\\\\\\|b");
		// パーサー (findUnescapedPipe) は `|` を escape 済みとして扱う
		expect(findUnescapedPipe(out, 0)).toBe(-1);
	});

	it("`\\\\` + `|` も奇数個の `\\` になる", () => {
		// 入力 `a\\|b` (a, \, \, |, b) → \ 倍化で 4 個 → \| で +1 → 5 個 (奇数)
		const out = escapeTableCell("a\\\\|b");
		expect(out).toBe("a\\\\\\\\\\|b");
		expect(findUnescapedPipe(out, 0)).toBe(-1);
	});

	it("改行を空白に潰す", () => {
		expect(escapeTableCell("a\nb")).toBe("a b");
	});

	it("CRLF も空白に潰す", () => {
		expect(escapeTableCell("a\r\nb")).toBe("a b");
	});

	it("連続する改行はまとめて 1 個の空白にする", () => {
		expect(escapeTableCell("a\n\nb")).toBe("a b");
	});

	it("複数種のメタ文字が混在してもパーサー通過セル数を維持する", () => {
		// 入力: `a|b\c\|d` → 出力の `|` は全て escape 済みで区切り無し
		const out = escapeTableCell("a|b\\c\\|d");
		expect(findUnescapedPipe(out, 0)).toBe(-1);
	});

	it("空文字列は空文字列", () => {
		expect(escapeTableCell("")).toBe("");
	});

	it("行末の lone `\\` は倍化されて出力される (caller 側 trim 後もパーサー安全)", () => {
		// 入力 `foo\` → 出力 `foo\\` (末尾 2 \)。tables.ts 側は結果を trim してから
		// `| ... |` に流し込むため、trim (末尾空白のみ) は `\` を落とさず、
		// 最終行 `| foo\\ |` を findUnescapedPipe で走査しても `|` は escape 済み
		// (直前が空白なので backslash count = 0 の偶数 → 区切りとして正しく認識される)。
		const out = escapeTableCell("foo\\");
		expect(out).toBe("foo\\\\");
		// caller 側 trim + 行組み立てのシミュレーション
		const trimmed = out.trim();
		const row = `| ${trimmed} |`;
		// 先頭 `|` (pos 0) は正しく区切りとして拾える
		expect(findUnescapedPipe(row, 0)).toBe(0);
		// 末尾 `|` も escape されていない (直前が空白)
		expect(findUnescapedPipe(row, 1)).toBe(row.length - 1);
	});
});
