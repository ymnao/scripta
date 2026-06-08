import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { buildTableDecorations, tableDecoration } from "./table-decoration";
import { createEmptyTable } from "./table-utils";
import {
	buildTsvTableChanges,
	insertTable,
	rangeOverlapsCodeOrTable,
	tableKeymap,
	tsvToMarkdownTable,
} from "./tables";
import { collectDecorations, createTestState, replaceDecorations } from "./test-helper";

const simpleTable = "| A | B |\n| --- | --- |\n| 1 | 2 |";

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

	it("本文行の直後に挿入され、本文と空行で区切られテーブル直下に行ができる", () => {
		const view = mountEditor("hello", 5);
		insertTable(view);
		const text = view.state.doc.toString();
		// 本文（hello）とテーブルの間に空行を入れる（密着すると lezer がテーブルを
		// 認識せずプレーンテキスト化するため）
		expect(text).toBe(`hello\n\n${createEmptyTable(3, 2)}\n`);
		expect(lastLineIsBlank(view)).toBe(true);
	});

	it("テーブル直下の本文の下に挿入しても両テーブルが描画される（プレーンテキスト化しない, #90）", () => {
		const tA = "| A | B |\n| --- | --- |\n| 1 | 2 |";
		const doc0 = `${tA}\ntext`; // テーブル + 密着本文
		const view = mountEditor(doc0, doc0.length); // カーソルは本文行末
		insertTable(view);

		const doc = view.state.doc.toString();
		// 本文とテーブル B の間に空行が入る
		expect(doc).toBe(`${tA}\ntext\n\n${createEmptyTable(3, 2)}\n`);

		// 結果ドキュメントで両テーブルが widget として認識される（密着なら 0 になる）
		const fresh = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
		ensureSyntaxTree(fresh, doc.length, Number.POSITIVE_INFINITY);
		const widgets = replaceDecorations(collectDecorations(buildTableDecorations(fresh))).length;
		expect(widgets).toBe(2);
	});

	it("本文行の直下の空行で挿入してもテーブル上に空行を確保する（プレーンテキスト化防止, #90）", () => {
		// "hello\n\n" の空行（line2）にカーソル。直上の本文行とテーブルの間には
		// 空行が必要（密着すると lezer がテーブルを認識しない）。
		const view = mountEditor("hello\n\n", 6);
		insertTable(view);
		const text = view.state.doc.toString();
		expect(text).toBe(`hello\n\n${createEmptyTable(3, 2)}\n`);
	});

	it("先頭または直上が空行なら追加の \\n は補わない（idempotent）", () => {
		// "\n" の line2（空行）にカーソル。直上(line1)も空行なので prefix なし。
		const view = mountEditor("\n", 1);
		insertTable(view);
		expect(view.state.doc.toString()).toBe(`\n${createEmptyTable(3, 2)}\n`);
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

// ── Backspace at the line directly below a table（#90 追補） ──
//
// widget DOM を参照するため tableDecoration も載せて real EditorView を起動する。

describe("backspaceIntoTableFromBelow (runtime)", () => {
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
			extensions: [markdown({ base: markdownLanguage }), tableDecoration, tableKeymap],
		});
		ensureSyntaxTree(state, state.doc.length, Number.POSITIVE_INFINITY);
		state = state.update({}).state;
		const view = new EditorView({ state, parent });
		view.focus();
		mounted.push(view);
		return view;
	}

	function pressBackspace(view: EditorView): boolean {
		return runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");
	}

	it("テーブル直下の非空行頭で Backspace するとマージせず最終セルへ入る", () => {
		const view = mountEditor(`${simpleTable}\ntext`, 0);
		const textLineFrom = view.state.doc.line(4).from;
		view.dispatch({ selection: { anchor: textLineFrom } });

		const handled = pressBackspace(view);

		// 消費され（handled）、かつドキュメントは変化しない（テーブル行へマージしない）。
		// focusCell の DOM フォーカスは jsdom では確実に観測できないため、handled=true
		// （= widget を見つけ focusCell まで到達）+ doc 不変で「マージ抑止」を担保する。
		expect(handled).toBe(true);
		expect(view.state.doc.toString()).toBe(`${simpleTable}\ntext`);
	});

	it("テーブル直下の空行頭の Backspace は既定に委譲する（handler は消費しない）", () => {
		const view = mountEditor(`${simpleTable}\n`, 0);
		const blankLineFrom = view.state.doc.line(4).from;
		view.dispatch({ selection: { anchor: blankLineFrom } });

		// 空行は通常の削除（テーブル直下の空行を詰める挙動）に任せるので消費しない
		expect(pressBackspace(view)).toBe(false);
	});

	it("テーブルが直上に無ければ Backspace を消費しない", () => {
		const view = mountEditor("hello\nworld", 0);
		view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
		expect(pressBackspace(view)).toBe(false);
	});

	it("表の直前行の末尾で ArrowRight を押すと表 (0,0) セルへ入る（左端巨大キャレット防止, #90）", () => {
		const doc = `text\n${simpleTable}`;
		const view = mountEditor(doc, 0);
		const line1End = view.state.doc.line(1).to;
		view.dispatch({ selection: { anchor: line1End } });

		const handled = runScopeHandlers(
			view,
			new KeyboardEvent("keydown", { key: "ArrowRight" }),
			"editor",
		);
		expect(handled).toBe(true);
		// ドキュメントは変化しない（カーソル移動のみ）
		expect(view.state.doc.toString()).toBe(doc);
	});

	it("表の直後行の先頭で ArrowLeft を押すと表の右下セルへ入る（#90）", () => {
		const doc = `${simpleTable}\ntext`;
		const view = mountEditor(doc, 0);
		const textLineFrom = view.state.doc.line(4).from;
		view.dispatch({ selection: { anchor: textLineFrom } });

		const handled = runScopeHandlers(
			view,
			new KeyboardEvent("keydown", { key: "ArrowLeft" }),
			"editor",
		);
		expect(handled).toBe(true);
		expect(view.state.doc.toString()).toBe(doc);
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

// ── tsvToMarkdownTable (#147) ────────────────────────

describe("tsvToMarkdownTable", () => {
	it("2行3列の TSV を Markdown テーブルに変換する", () => {
		const grid = [
			["名前", "年齢", "都市"],
			["Alice", "30", "東京"],
		];
		const result = tsvToMarkdownTable(grid);
		const lines = result.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(/^\| 名前\s+\| 年齢\s+\| 都市\s+\|$/);
		expect(lines[1]).toMatch(/^\| ---/);
		expect(lines[2]).toMatch(/^\| Alice\s+\| 30\s+\| 東京\s+\|$/);
	});

	it("1行の TSV はヘッダ＋区切り行のみ生成する", () => {
		const grid = [["A", "B", "C"]];
		const result = tsvToMarkdownTable(grid);
		const lines = result.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("| A");
		expect(lines[1]).toMatch(/^\| ---/);
	});

	it("セル内のパイプがエスケープされる", () => {
		const grid = [
			["key", "value"],
			["a|b", "c"],
		];
		const result = tsvToMarkdownTable(grid);
		expect(result).toContain("a\\|b");
		expect(result).not.toMatch(/a\|b/);
	});

	it("列数が不揃いでも最大列数に揃う", () => {
		const grid = [["A", "B", "C"], ["1"]];
		const result = tsvToMarkdownTable(grid);
		const lines = result.split("\n");
		// データ行もパイプ 4 本（3列分）
		expect(lines[2].split("|").length - 1).toBe(4);
	});

	it("3行以上の TSV でヘッダ＋区切り＋複数データ行を生成する", () => {
		const grid = [
			["H1", "H2"],
			["a", "b"],
			["c", "d"],
		];
		const result = tsvToMarkdownTable(grid);
		const lines = result.split("\n");
		expect(lines).toHaveLength(4);
	});

	it("CJK 全角文字の列幅が表示幅ベースで揃う", () => {
		const grid = [
			["名前", "age"],
			["太郎", "20"],
		];
		const result = tsvToMarkdownTable(grid);
		const lines = result.split("\n");
		// "名前" は表示幅 4、"age" は表示幅 3 → 列幅 4 と 3
		// ヘッダ行: "| 名前 | age |" — "名前" はパディング不要（幅4=列幅4）
		expect(lines[0]).toBe("| 名前 | age |");
		// 区切り行の幅がヘッダ表示幅と一致する
		expect(lines[1]).toBe("| ---- | --- |");
		// データ行: "太郎" も表示幅 4 でパディング不要
		expect(lines[2]).toBe("| 太郎 | 20  |");
	});

	it("セル内改行がスペースに正規化される", () => {
		const grid = [
			["A", "B"],
			["hello\nworld", "x"],
		];
		const result = tsvToMarkdownTable(grid);
		const lines = result.split("\n");
		// テーブルは 3 行（ヘッダ + 区切り + データ）で壊れない
		expect(lines).toHaveLength(3);
		// 改行がスペースに置換されている
		expect(lines[2]).toContain("hello world");
		expect(lines[2]).not.toContain("\n");
	});

	it("連続改行・CRLF もスペース 1 つに正規化される", () => {
		const grid = [["H"], ["a\r\nb"], ["c\n\n\nd"]];
		const result = tsvToMarkdownTable(grid);
		const lines = result.split("\n");
		expect(lines).toHaveLength(4); // header + sep + 2 data
		expect(lines[2]).toContain("a b");
		expect(lines[3]).toContain("c d");
	});
});

// ── buildTsvTableChanges (#147) ─────────────────────────
//
// changeByRange の挿入位置ロジックをテストする。テーブルがブロック要素として
// 行内テキストに直結せず、前後が空行で分離されることを検証する。

describe("buildTsvTableChanges", () => {
	const simpleMd = tsvToMarkdownTable([
		["A", "B"],
		["1", "2"],
	]);

	/** EditorState を作り changeByRange の結果を適用して doc 文字列を返す */
	function apply(doc: string, anchor: number, head?: number): string {
		const sel = head != null ? EditorSelection.range(anchor, head) : EditorSelection.cursor(anchor);
		const state = EditorState.create({
			doc,
			selection: EditorSelection.create([sel]),
		});
		return state.update(buildTsvTableChanges(state, simpleMd)).state.doc.toString();
	}

	it("空行上の空カーソルで行全体をテーブルに置き換える", () => {
		const result = apply("above\n\nbelow", 6);
		expect(result).toContain(simpleMd);
		// テーブルは前後の行と空行で分離される
		expect(result).toContain(`above\n\n${simpleMd}`);
	});

	it("非空行の行中カーソルでもテーブルは行末に挿入される", () => {
		// "he|llo" — カーソルは行中だがテーブルは行全体の後に配置
		const result = apply("hello", 2);
		expect(result.startsWith("hello\n")).toBe(true);
		expect(result).toContain(simpleMd);
		// "llo" がテーブル最終行に直結しない
		expect(result).not.toContain("|\nhello");
	});

	it("非空行の行末カーソルではテーブルが行の後に挿入される", () => {
		const result = apply("hello", 5);
		expect(result.startsWith("hello\n")).toBe(true);
		expect(result).toContain(simpleMd);
	});

	it("行中選択の残余テキストがテーブルの後に分離される", () => {
		// "he[ll]o" — "o" はテーブル最終行に直結せず別行へ
		const result = apply("hello", 2, 4);
		expect(result).toContain(simpleMd);
		// テーブル最終行に "o" が直結しない
		expect(result).not.toMatch(/\|o/);
		// "o" は空行を挟んでテーブルの後に存在する
		const tableEnd = result.indexOf(simpleMd) + simpleMd.length;
		expect(result.slice(tableEnd)).toBe("\n\no");
	});

	it("行全体の選択ではテーブルで置換される（残余なし）", () => {
		const result = apply("hello\nworld", 0, 5);
		// "hello" がテーブルに置換され "world" は次行に残る
		expect(result.startsWith(simpleMd)).toBe(true);
		expect(result).toContain("world");
	});

	it("複数行にまたがる選択でも残余テキストが分離される", () => {
		// "he[llo\\nwor]ld" — trailing "ld" がテーブル後に退避
		const result = apply("hello\nworld", 2, 9);
		expect(result).toContain(simpleMd);
		const tableEnd = result.indexOf(simpleMd) + simpleMd.length;
		expect(result.slice(tableEnd)).toBe("\n\nld");
	});
});

// ── rangeOverlapsCodeOrTable (#147) ──────────────────
//
// 半開区間の境界判定を検証する。syntaxTree().iterate は inclusive に重なる
// ノードを返すが、非空選択では [from, to) として境界接触を除外する。

describe("rangeOverlapsCodeOrTable", () => {
	const tableDoc = `abc\n\n${simpleTable}`;
	const fencedDoc = "abc\n\n```\ncode\n```";

	it("空カーソルがテーブル内にあるとき true", () => {
		const state = createTestState(tableDoc);
		// テーブル開始行の先頭にカーソル
		const tableFrom = state.doc.line(3).from;
		expect(rangeOverlapsCodeOrTable(state, tableFrom, tableFrom)).toBe(true);
	});

	it("空カーソルがテーブル外にあるとき false", () => {
		const state = createTestState(tableDoc);
		// "abc" の先頭
		expect(rangeOverlapsCodeOrTable(state, 0, 0)).toBe(false);
	});

	it("選択がテーブルの直前で終わる場合 false（境界接触は除外）", () => {
		const state = createTestState(tableDoc);
		// "abc\n\n" を選択 — to はテーブル開始位置と同じだが半開区間では含まない
		const tableFrom = state.doc.line(3).from;
		expect(rangeOverlapsCodeOrTable(state, 0, tableFrom)).toBe(false);
	});

	it("選択がテーブルに 1 文字でも入ると true", () => {
		const state = createTestState(tableDoc);
		const tableFrom = state.doc.line(3).from;
		expect(rangeOverlapsCodeOrTable(state, 0, tableFrom + 1)).toBe(true);
	});

	it("選択がテーブルの直後から始まる場合 false（境界接触は除外）", () => {
		// テーブル最終行の to の次（= 空行の from）から選択開始
		const state = createTestState(`${simpleTable}\n\nabc`);
		const tableTo = state.doc.line(3).to;
		const afterTable = tableTo + 1; // 空行の from
		expect(rangeOverlapsCodeOrTable(state, afterTable, state.doc.length)).toBe(false);
	});

	it("選択が fenced code の直前で終わる場合 false（境界接触は除外）", () => {
		const state = createTestState(fencedDoc);
		// "abc\n\n" を選択 — to は ``` 開始位置と同じ
		const codeFrom = state.doc.line(3).from;
		expect(rangeOverlapsCodeOrTable(state, 0, codeFrom)).toBe(false);
	});

	it("選択が fenced code に 1 文字でも入ると true", () => {
		const state = createTestState(fencedDoc);
		const codeFrom = state.doc.line(3).from;
		expect(rangeOverlapsCodeOrTable(state, 0, codeFrom + 1)).toBe(true);
	});

	it("空カーソルが fenced code 内にあるとき true", () => {
		const state = createTestState(fencedDoc);
		const codeLine = state.doc.line(4).from; // "code" 行
		expect(rangeOverlapsCodeOrTable(state, codeLine, codeLine)).toBe(true);
	});

	it("テーブル直後の本文行（lezer Table 範囲内だが trimmed 外）では false", () => {
		// lezer は Table ノードに直後の本文行を含む場合がある
		const doc = `${simpleTable}\ntext`;
		const state = createTestState(doc);
		const textLine = state.doc.line(4);
		expect(rangeOverlapsCodeOrTable(state, textLine.from, textLine.to)).toBe(false);
	});
});
