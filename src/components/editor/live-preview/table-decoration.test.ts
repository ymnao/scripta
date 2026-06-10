import { history, redo, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildTableDecorations,
	clearCellSelection,
	exitTableDown,
	parseTsv,
	pasteIntoCell,
	sanitizePasteText,
	tableDecoration,
} from "./table-decoration";
import {
	collectDecorations,
	createTestState,
	replaceDecorations,
	widgetDecorations,
} from "./test-helper";

const simpleTable = `| A | B |
| --- | --- |
| 1 | 2 |`;

describe("buildTableDecorations", () => {
	it("テーブルがある場合、デコレーションが生成される", () => {
		const doc = `Hello\n\n${simpleTable}\n\nWorld`;
		const state = createTestState(doc);
		const decos = collectDecorations(buildTableDecorations(state));
		const replaces = replaceDecorations(decos);
		expect(replaces.length).toBe(1);
	});

	it("テーブルがない場合、デコレーションが生成されない", () => {
		const doc = "Hello\n\nWorld";
		const state = createTestState(doc);
		const decos = collectDecorations(buildTableDecorations(state));
		expect(decos.length).toBe(0);
	});

	it("2×2未満のテーブルはデコレーションされない", () => {
		const doc = "| A |\n| --- |\n| 1 |";
		const state = createTestState(doc);
		const decos = collectDecorations(buildTableDecorations(state));
		expect(decos.length).toBe(0);
	});

	it("複数テーブルがある場合、それぞれデコレーションされる", () => {
		const doc = `${simpleTable}\n\ntext\n\n${simpleTable}`;
		const state = createTestState(doc);
		const decos = collectDecorations(buildTableDecorations(state));
		const replaces = replaceDecorations(decos);
		expect(replaces.length).toBe(2);
	});

	it("アライメントが異なるテーブルは異なるウィジェットを生成する", () => {
		const leftTable = "| A | B |\n| :--- | :--- |\n| 1 | 2 |";
		const rightTable = "| A | B |\n| ---: | ---: |\n| 1 | 2 |";
		const centerTable = "| A | B |\n| :---: | :---: |\n| 1 | 2 |";

		const stateL = createTestState(leftTable);
		const stateR = createTestState(rightTable);
		const stateC = createTestState(centerTable);

		const widgetL = widgetDecorations(collectDecorations(buildTableDecorations(stateL)));
		const widgetR = widgetDecorations(collectDecorations(buildTableDecorations(stateR)));
		const widgetC = widgetDecorations(collectDecorations(buildTableDecorations(stateC)));

		expect(widgetL.length).toBe(1);
		expect(widgetR.length).toBe(1);
		expect(widgetC.length).toBe(1);

		// eq() should return false for different alignments
		const wL = widgetL[0].value.spec.widget;
		const wR = widgetR[0].value.spec.widget;
		const wC = widgetC[0].value.spec.widget;
		expect(wL.eq(wR)).toBe(false);
		expect(wL.eq(wC)).toBe(false);
		expect(wR.eq(wC)).toBe(false);
	});

	describe("ignoreEvent", () => {
		function getWidget() {
			const state = createTestState(simpleTable);
			const decos = widgetDecorations(collectDecorations(buildTableDecorations(state)));
			return decos[0].value.spec.widget;
		}

		it("セル内クリックは true を返す（ウィジェットが処理）", () => {
			const widget = getWidget();
			const td = document.createElement("td");
			const event = new MouseEvent("mousedown", { bubbles: true });
			Object.defineProperty(event, "target", { value: td });
			expect(widget.ignoreEvent(event)).toBe(true);
		});

		it("セル外（padding 帯）クリックは false を返す（エディタに委譲）", () => {
			const widget = getWidget();
			const div = document.createElement("div");
			const event = new MouseEvent("mousedown", { bubbles: true });
			Object.defineProperty(event, "target", { value: div });
			expect(widget.ignoreEvent(event)).toBe(false);
		});

		it("セル外の Text ノードは false を返す（エディタに委譲）", () => {
			const widget = getWidget();
			const div = document.createElement("div");
			const text = document.createTextNode("hello");
			div.appendChild(text);
			const event = new MouseEvent("mousedown", { bubbles: true });
			Object.defineProperty(event, "target", { value: text });
			expect(widget.ignoreEvent(event)).toBe(false);
		});

		it("セル内の Text ノードは parentElement 経由で true を返す", () => {
			const widget = getWidget();
			const td = document.createElement("td");
			const text = document.createTextNode("cell text");
			td.appendChild(text);
			const event = new MouseEvent("mousedown", { bubbles: true });
			Object.defineProperty(event, "target", { value: text });
			expect(widget.ignoreEvent(event)).toBe(true);
		});

		it("Ctrl/Cmd+キーは false を返す", () => {
			const widget = getWidget();
			const event = new KeyboardEvent("keydown", { key: "s", metaKey: true });
			expect(widget.ignoreEvent(event)).toBe(false);
		});
	});

	it("同じアライメント・内容のテーブルは eq() が true を返す", () => {
		const table = "| A | B |\n| :---: | --- |\n| 1 | 2 |";
		const state1 = createTestState(table);
		const state2 = createTestState(table);

		const w1 = widgetDecorations(collectDecorations(buildTableDecorations(state1)));
		const w2 = widgetDecorations(collectDecorations(buildTableDecorations(state2)));

		expect(w1[0].value.spec.widget.eq(w2[0].value.spec.widget)).toBe(true);
	});
});

// ── sanitizePasteText（#89） ──

describe("sanitizePasteText", () => {
	it("`|` を除去する（テーブル構文を壊さない）", () => {
		expect(sanitizePasteText("a|b|c")).toBe("abc");
	});

	it("改行をスペースに置換する", () => {
		expect(sanitizePasteText("a\nb")).toBe("a b");
		expect(sanitizePasteText("a\r\nb")).toBe("a b");
		expect(sanitizePasteText("a\n\n\nb")).toBe("a b");
	});

	it("空文字列は空文字列を返す", () => {
		expect(sanitizePasteText("")).toBe("");
	});

	it("通常テキストはそのまま返す", () => {
		expect(sanitizePasteText("hello world")).toBe("hello world");
	});
});

// ── selection clamp / exitTableDown / paste（#90 part2,3 / #89） ──
//
// dispatch・widget DOM を伴うため real EditorView を jsdom 上で起動して検証する。

describe("table runtime (clamp / exitTableDown / paste)", () => {
	const mounted: EditorView[] = [];

	afterEach(() => {
		while (mounted.length > 0) {
			mounted.pop()?.destroy();
		}
	});

	function mountEditor(doc: string, cursorPos = 0, extraExtensions: Extension[] = []): EditorView {
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		let state = EditorState.create({
			doc,
			selection: EditorSelection.cursor(cursorPos),
			extensions: [markdown({ base: markdownLanguage }), tableDecoration, ...extraExtensions],
		});
		ensureSyntaxTree(state, state.doc.length, Number.POSITIVE_INFINITY);
		state = state.update({}).state;
		const view = new EditorView({ state, parent });
		view.focus();
		mounted.push(view);
		return view;
	}

	it("selection head がテーブル末尾境界に来ると次行先頭へ退避する", () => {
		const doc = `${simpleTable}\n\ntext`;
		const view = mountEditor(doc);
		const endTo = view.state.doc.line(3).to; // テーブル最終行の行末
		view.dispatch({ selection: { anchor: endTo } });
		// 巨大キャレットを避けて次行先頭へ
		expect(view.state.selection.main.head).toBe(endTo + 1);
	});

	it("先頭テーブルの左上セルで ArrowUp は何もしない（ドキュメントを改変しない, #90）", () => {
		const view = mountEditor(simpleTable); // テーブルが doc 先頭
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement | null;
		const cell = wrapper?.querySelector('[data-row="0"][data-col="0"]') as HTMLElement | null;
		expect(cell).not.toBeNull();
		if (!cell) return;
		cell.focus();
		cell.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
		);
		// ドキュメント・カーソルとも変化しない
		expect(view.state.doc.toString()).toBe(simpleTable);
	});

	it("先頭テーブルの左上セルでセル先頭 ArrowLeft は preventDefault され抑止される（巨大キャレット防止, #90）", () => {
		const view = mountEditor(simpleTable);
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement | null;
		const cell = wrapper?.querySelector('[data-row="0"][data-col="0"]') as HTMLElement | null;
		expect(cell).not.toBeNull();
		if (!cell) return;
		cell.focus();
		// セル先頭にキャレットを置く
		const range = document.createRange();
		range.selectNodeContents(cell);
		range.collapse(true);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);

		const ev = new KeyboardEvent("keydown", {
			key: "ArrowLeft",
			bubbles: true,
			cancelable: true,
		});
		cell.dispatchEvent(ev);
		// セル外へ抜けない（native の caret 移動も止める）
		expect(ev.defaultPrevented).toBe(true);
		expect(view.state.doc.toString()).toBe(simpleTable);
	});

	it("唯一のテーブルを削除する transaction で stale な末尾境界に退避しない（#90）", () => {
		// tr.startState の decoration の末尾を newDoc にマップするだけだと、削除した
		// テーブルの「古い末尾 → 削除後 0」が trailing と誤認され空 doc に \n が補われる。
		// tr.state（適用後 state）の decoration を読むことで、消えたテーブルは初めから
		// 末尾候補に含まれない。
		const view = mountEditor(simpleTable);
		view.dispatch({ changes: { from: 0, to: simpleTable.length }, selection: { anchor: 0 } });
		expect(view.state.doc.toString()).toBe("");
		expect(view.state.selection.main.head).toBe(0);
	});

	it("空 doc にテーブルを insert して selection がその末尾に来るなら退避が走る（新規テーブル境界, #90）", () => {
		// この transaction で初めて生まれるテーブルは tr.startState の decoration には
		// 含まれないため、startState ベースだと dodge も EOF 改行補完も走らず巨大キャレット
		// が出てしまう。tr.state を見れば新規テーブル境界もきちんと拾える。
		const view = mountEditor("");
		view.dispatch({
			changes: { from: 0, insert: simpleTable },
			selection: { anchor: simpleTable.length },
		});
		expect(view.state.doc.toString()).toBe(`${simpleTable}\n`);
		expect(view.state.selection.main.head).toBe(simpleTable.length + 1);
	});

	it("fenced code block 内のパイプ行は退避対象にしない（widget でない場所での誤発火防止, #90）", () => {
		// code fence 内に表っぽい行が並んでいても widget 化されないので末尾境界 dodge は
		// 走らない。以前は doc テキストベースで判定していたため誤発火していた。
		const doc = "```\n| 1 | 2 |\n| --- | --- |\n| 3 | 4 |\n```";
		const view = mountEditor(doc);
		// fence 内最終行の行末（= "| 3 | 4 |" の末尾）にカーソルを置いても dodge しない
		const lastFenceContentLine = view.state.doc.line(4);
		view.dispatch({ selection: { anchor: lastFenceContentLine.to } });
		expect(view.state.doc.toString()).toBe(doc);
		expect(view.state.selection.main.head).toBe(lastFenceContentLine.to);
	});

	it("テーブル末尾境界以外の selection はそのまま", () => {
		const doc = `${simpleTable}\n\ntext`;
		const view = mountEditor(doc);
		const textPos = doc.indexOf("text");
		view.dispatch({ selection: { anchor: textPos } });
		expect(view.state.selection.main.head).toBe(textPos);
	});

	it("末尾境界が EOF（直下に行が無い既存テーブル）なら改行を 1 つ補ってそこへ退避する", () => {
		// 手入力・インポート済みファイルにありがちな「テーブルで終わる」ドキュメント
		const view = mountEditor(simpleTable);
		const endTo = view.state.doc.line(3).to;
		expect(endTo).toBe(simpleTable.length); // テーブルが EOF

		view.dispatch({ selection: { anchor: endTo } });

		// 改行が 1 つだけ補われ（余分な空行を作らない）、巨大キャレット位置（endTo）に留まらない
		expect(view.state.doc.toString()).toBe(`${simpleTable}\n`);
		expect(view.state.selection.main.head).toBe(endTo + 1);
		// テーブル直下に編集可能な 1 行ができている
		const { doc } = view.state;
		expect(doc.line(doc.lines).text).toBe("");
	});

	it("EOF 退避で補った行へは再入（無限ループ）せず、改行を二重に補わない", () => {
		const view = mountEditor(simpleTable);
		const endTo = view.state.doc.line(3).to;
		view.dispatch({ selection: { anchor: endTo } });
		// 一度補ったら以降は直下に行が存在するので二重に改行を補わない
		const afterFirst = view.state.doc.toString();
		view.dispatch({ selection: { anchor: view.state.doc.line(3).to } });
		expect(view.state.doc.toString()).toBe(afterFirst);
		expect(view.state.doc.toString()).toBe(`${simpleTable}\n`);
	});

	it("selection head がテーブル先頭境界に来ると前行末尾へ退避する (#146)", () => {
		const doc = `text\n\n${simpleTable}`;
		const view = mountEditor(doc);
		const tableFrom = doc.indexOf("|");
		view.dispatch({ selection: { anchor: tableFrom } });
		// 巨大キャレットを避けて前行（空行）の末尾へ
		expect(view.state.selection.main.head).toBe(tableFrom - 1);
		expect(view.state.doc.toString()).toBe(doc);
	});

	it("先頭境界が DOC 先頭（直上に行が無いテーブル）なら改行を 1 つ補ってそこへ退避する (#146)", () => {
		const view = mountEditor(simpleTable);
		view.dispatch({ selection: { anchor: 0 } });
		// 改行が 1 つだけ補われ、カーソルは補った空行の先頭（巨大キャレット位置に留まらない）
		expect(view.state.doc.toString()).toBe(`\n${simpleTable}`);
		expect(view.state.selection.main.head).toBe(0);
		expect(view.state.doc.line(1).text).toBe("");
	});

	it("DOC 先頭退避で補った行へは再入せず、改行を二重に補わない (#146)", () => {
		const view = mountEditor(simpleTable);
		view.dispatch({ selection: { anchor: 0 } });
		const afterFirst = view.state.doc.toString();
		// 一度補ったらテーブル先頭境界は 1 にずれるので、0 への再 dispatch では何も起きない
		view.dispatch({ selection: { anchor: 0 } });
		expect(view.state.doc.toString()).toBe(afterFirst);
		expect(view.state.doc.toString()).toBe(`\n${simpleTable}`);
	});

	it("multi-cursor で BOF と EOF の境界に同時に来ても両カーソルが正しく退避する (#146)", () => {
		// 先頭挿入は後続の全座標を +1 ずらすため、prepend と append が同時に起きると
		// 末尾側の退避先にシフトを織り込む必要がある（multi-cursor 限定の座標バグ回帰）
		const view = mountEditor(simpleTable, 0, [EditorState.allowMultipleSelections.of(true)]);
		view.dispatch({
			selection: EditorSelection.create(
				[EditorSelection.cursor(0), EditorSelection.cursor(simpleTable.length)],
				0,
			),
		});
		// 先頭・末尾に改行が 1 つずつ補われる
		expect(view.state.doc.toString()).toBe(`\n${simpleTable}\n`);
		// 補った先頭空行の行頭(0)と補った末尾空行の行頭(L+2)に 2 カーソルが残る
		expect(view.state.selection.ranges.map((r) => r.head)).toEqual([0, simpleTable.length + 2]);
	});

	it("multi-cursor で BOF 退避と通常カーソルが共存しても通常カーソルがずれない (#146)", () => {
		const doc = `${simpleTable}\n\ntext`;
		const view = mountEditor(doc, 0, [EditorState.allowMultipleSelections.of(true)]);
		const textPos = doc.indexOf("text");
		view.dispatch({
			selection: EditorSelection.create(
				[EditorSelection.cursor(0), EditorSelection.cursor(textPos)],
				0,
			),
		});
		expect(view.state.doc.toString()).toBe(`\n${doc}`);
		// BOF カーソルは補った空行頭(0)、通常カーソルは "text" の頭（prepend で +1）
		expect(view.state.selection.ranges.map((r) => r.head)).toEqual([0, textPos + 1]);
	});

	it("exitTableDown: 直下に行が無ければ改行を 1 つ補ってカーソルを置く", () => {
		const view = mountEditor(simpleTable); // テーブルが EOF（直下に空行なし）
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement | null;
		expect(wrapper).not.toBeNull();
		if (!wrapper) return;

		exitTableDown(view, wrapper);
		expect(view.state.doc.toString()).toBe(`${simpleTable}\n`);
		// 補った空行の先頭にカーソル
		expect(view.state.selection.main.head).toBe(simpleTable.length + 1);
	});

	it("exitTableDown: 直下に行があれば追加せずその行頭へ", () => {
		const doc = `${simpleTable}\n\ntext`;
		const view = mountEditor(doc);
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement | null;
		expect(wrapper).not.toBeNull();
		if (!wrapper) return;

		exitTableDown(view, wrapper);
		// ドキュメントは変わらない（空行を二重に作らない）
		expect(view.state.doc.toString()).toBe(doc);
		// line4（空行）の行頭へ
		expect(view.state.selection.main.head).toBe(view.state.doc.line(4).from);
	});

	it("exitTableDown: 本文が密着していても巻き込まず本文行頭へ抜ける（飲み込み防止, #90）", () => {
		// テーブル直下に本文が密着（lezer の Table ノードが本文行を含むケース）。
		// trim した最終行で判定するので、本文を表へ巻き込まず行頭へ抜ける。
		const doc = `${simpleTable}\ntext`;
		const view = mountEditor(doc);
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement | null;
		expect(wrapper).not.toBeNull();
		if (!wrapper) return;

		exitTableDown(view, wrapper);
		// 改行を挿入せず（飲み込まず）、本文行頭へ
		expect(view.state.doc.toString()).toBe(doc);
		expect(view.state.selection.main.head).toBe(view.state.doc.line(4).from);
		expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("text");
	});

	it("pasteIntoCell: フォーカスセルにテキストを挿入しドキュメントへ反映する", () => {
		const view = mountEditor(simpleTable);
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement | null;
		expect(wrapper).not.toBeNull();
		if (!wrapper) return;

		const cell = wrapper.querySelector('[data-row="0"][data-col="0"]') as HTMLElement | null;
		expect(cell).not.toBeNull();
		if (!cell) return;

		pasteIntoCell(cell, "X", view, wrapper);
		// セル DOM に挿入される
		expect(cell.textContent).toContain("X");
		// ドキュメント 1 行目（ヘッダ行）に反映される
		expect(view.state.doc.line(1).text).toContain("X");
	});

	it("pasteIntoCell: セルをまたぐ選択時は対象セル末尾へ追記し他セルを壊さない", () => {
		const view = mountEditor(simpleTable);
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement | null;
		expect(wrapper).not.toBeNull();
		if (!wrapper) return;

		const cellA = wrapper.querySelector('[data-row="0"][data-col="0"]') as HTMLElement | null;
		const cellB = wrapper.querySelector('[data-row="0"][data-col="1"]') as HTMLElement | null;
		expect(cellA?.firstChild).toBeTruthy();
		expect(cellB?.firstChild).toBeTruthy();
		if (!cellA?.firstChild || !cellB?.firstChild) return;

		// セル A → セル B にまたがる選択を作る
		const range = document.createRange();
		range.setStart(cellA.firstChild, 0);
		range.setEnd(cellB.firstChild, 1);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);

		pasteIntoCell(cellA, "X", view, wrapper);

		// 対象セル A の末尾へ追記され、セル B は消えない（deleteContents で巻き込まない）
		expect(cellA.textContent).toBe("AX");
		expect(cellB.textContent).toBe("B");
		// DOM と Markdown が一致（ヘッダ行 = | AX | B |）
		expect(view.state.doc.line(1).text).toBe("| AX | B |");
	});

	it("Cmd/Ctrl + V/C/X はセル内 keydown で preventDefault されない（native clipboard を通す, #89）", () => {
		const view = mountEditor(simpleTable);
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement | null;
		const cell = wrapper?.querySelector('[data-row="0"][data-col="0"]') as HTMLElement | null;
		expect(cell).not.toBeNull();
		if (!cell) return;
		cell.focus();

		for (const key of ["v", "c", "x"]) {
			const ev = new KeyboardEvent("keydown", {
				key,
				metaKey: true,
				bubbles: true,
				cancelable: true,
			});
			cell.dispatchEvent(ev);
			// native の paste/copy/cut イベントが発火するよう default を残す
			expect(ev.defaultPrevented).toBe(false);
		}
	});

	it("クリップボード以外の Mod+key（Cmd+B 等）はセル内 keydown で preventDefault される（装飾抑止, #89）", () => {
		const view = mountEditor(simpleTable);
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement | null;
		const cell = wrapper?.querySelector('[data-row="0"][data-col="0"]') as HTMLElement | null;
		expect(cell).not.toBeNull();
		if (!cell) return;
		cell.focus();

		const ev = new KeyboardEvent("keydown", {
			key: "b",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		cell.dispatchEvent(ev);
		// contentEditable の bold 化を抑止するため default を止める
		expect(ev.defaultPrevented).toBe(true);
	});

	it("Cmd/Ctrl+A はセル内容だけを選択し、CM の doc 全選択へ伝播しない", () => {
		const view = mountEditor(simpleTable);
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement | null;
		const cell = wrapper?.querySelector('[data-row="0"][data-col="0"]') as HTMLElement | null;
		expect(cell).not.toBeNull();
		if (!cell) return;
		cell.focus();

		// wrapper の上位（contentDOM）に届けば CM の Mod-a (doc 全選択) が走ってしまう
		let reachedEditor = false;
		const onKey = () => {
			reachedEditor = true;
		};
		view.contentDOM.addEventListener("keydown", onKey);
		const ev = new KeyboardEvent("keydown", {
			key: "a",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		cell.dispatchEvent(ev);
		view.contentDOM.removeEventListener("keydown", onKey);

		// native / CM 双方の全選択を止める（preventDefault + stopPropagation）
		expect(ev.defaultPrevented).toBe(true);
		expect(reachedEditor).toBe(false);
		// セルの内容だけが選択される（doc 全体ではない）
		const sel = window.getSelection();
		expect(sel?.toString()).toBe("A");
	});

	it("セル入力（input イベント）→ Cmd/Ctrl+Z で「いま打っていたセル」が確実に戻る（#90）", () => {
		// 表外で 1 編集 → セル内タイプ相当の入力 → Cmd+Z でセル編集だけを戻し、
		// もう 1 回 Cmd+Z で表外編集を戻す（history のグループ化が崩れないことの担保）。
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		const initial = `hello\n\n${simpleTable}`;
		let state = EditorState.create({
			doc: initial,
			selection: EditorSelection.cursor(0),
			extensions: [history(), markdown({ base: markdownLanguage }), tableDecoration],
		});
		ensureSyntaxTree(state, state.doc.length, Number.POSITIVE_INFINITY);
		state = state.update({}).state;
		const view = new EditorView({ state, parent });
		mounted.push(view);

		// 表外編集（hello → hello!）
		view.dispatch({ changes: { from: 5, insert: "!" } });
		const afterOuter = view.state.doc.toString();

		// セル内タイプ（input イベント経由）— データ行(row 1)・col 0 を "1" → "1X" に
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement;
		const cell = wrapper.querySelector('[data-row="1"][data-col="0"]') as HTMLElement;
		cell.textContent = "1X";
		cell.dispatchEvent(new Event("input", { bubbles: true }));
		const afterCell = view.state.doc.toString();
		expect(afterCell).toContain("| 1X | 2 |");

		// Cmd+Z 1 回 → セル編集だけ戻る（表外編集は残る）
		undo(view);
		expect(view.state.doc.toString()).toBe(afterOuter);

		// Cmd+Z もう 1 回 → 表外編集も戻る
		undo(view);
		expect(view.state.doc.toString()).toBe(initial);
	});

	it("セル内 beforeinput(historyUndo) で CM の undo が走り native の per-cell undo を抑止する（#90）", () => {
		// contentEditable 内では Cmd+Z やメニュー Undo が beforeinput(historyUndo) に集約される。
		// keydown だけだと取りこぼす経路（Electron menu role 経由 等）があるため、beforeinput
		// で確実に CM history へ橋渡しする。
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		let state = EditorState.create({
			doc: simpleTable,
			selection: EditorSelection.cursor(0),
			extensions: [history(), markdown({ base: markdownLanguage }), tableDecoration],
		});
		ensureSyntaxTree(state, state.doc.length, Number.POSITIVE_INFINITY);
		state = state.update({}).state;
		const view = new EditorView({ state, parent });
		mounted.push(view);

		// 履歴に積む 1 編集
		view.dispatch({ changes: { from: simpleTable.length, insert: "\nX" } });
		expect(view.state.doc.toString()).toBe(`${simpleTable}\nX`);

		// セル内で beforeinput(historyUndo) を発火させる
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement | null;
		const cell = wrapper?.querySelector('[data-row="0"][data-col="0"]') as HTMLElement | null;
		expect(cell).not.toBeNull();
		if (!cell) return;
		const ev = new InputEvent("beforeinput", {
			inputType: "historyUndo",
			bubbles: true,
			cancelable: true,
		});
		cell.dispatchEvent(ev);

		// preventDefault で native の per-cell undo を抑止しつつ CM の undo を実行
		expect(ev.defaultPrevented).toBe(true);
		expect(view.state.doc.toString()).toBe(simpleTable);
	});

	it("undo が走ったら、フォーカス中でもセル DOM がドキュメントの内容に追従する（#90 表内 Cmd+Z 真因）", () => {
		// 旧 updateDOM は「フォーカス中のセルは更新スキップ」という最適化があり、
		// セル内 Cmd+Z で state.doc が戻っても DOM が古い内容のまま残り、見た目上
		// 「Cmd+Z が効かない」状態になっていた。差分があれば必ず DOM を追従させる。
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		let state = EditorState.create({
			doc: simpleTable,
			selection: EditorSelection.cursor(0),
			extensions: [history(), markdown({ base: markdownLanguage }), tableDecoration],
		});
		ensureSyntaxTree(state, state.doc.length, Number.POSITIVE_INFINITY);
		state = state.update({}).state;
		const view = new EditorView({ state, parent });
		mounted.push(view);

		// セル (1, 0) にフォーカスを置き、typing 経路を再現する
		const wrapper = view.dom.querySelector(".cm-table-widget") as HTMLElement;
		const cell = wrapper.querySelector('[data-row="1"][data-col="0"]') as HTMLElement;
		cell.focus();
		cell.textContent = "1X";
		cell.dispatchEvent(new Event("input", { bubbles: true }));
		expect(view.state.doc.toString()).toContain("| 1X | 2 |");

		// undo を発火（フォーカスはセルに残ったまま）
		undo(view);
		expect(view.state.doc.toString()).toBe(simpleTable);

		// セル DOM も追従して "1" に戻っている（フォーカス中でも更新される）
		const cellAfter = (view.dom.querySelector(".cm-table-widget") as HTMLElement).querySelector(
			'[data-row="1"][data-col="0"]',
		) as HTMLElement;
		expect(cellAfter.textContent).toBe("1");
	});

	it("ignoreEvent は historyUndo / historyRedo InputEvent を CM に通す（CM の history が処理できるように, #90）", () => {
		// CM6 の history() 拡張は beforeinput(inputType=historyUndo/Redo) をハンドラとして
		// 登録する。widget が ignoreEvent=true を返すと eventBelongsToEditor が false に
		// なり CM のハンドラチェーンが走らなくなって native の per-cell undo に
		// フォールバックしてしまうので、これらの InputEvent は ignoreEvent=false で通す。
		const state = createTestState(simpleTable);
		const widget = widgetDecorations(collectDecorations(buildTableDecorations(state)))[0].value.spec
			.widget;
		const evUndo = new InputEvent("beforeinput", {
			inputType: "historyUndo",
			bubbles: true,
			cancelable: true,
		});
		const evRedo = new InputEvent("beforeinput", {
			inputType: "historyRedo",
			bubbles: true,
			cancelable: true,
		});
		const evType = new InputEvent("beforeinput", {
			inputType: "insertText",
			bubbles: true,
			cancelable: true,
		});
		expect(widget.ignoreEvent(evUndo)).toBe(false);
		expect(widget.ignoreEvent(evRedo)).toBe(false);
		// 通常の入力は引き続き ignore（自前の input ハンドラで処理する）
		expect(widget.ignoreEvent(evType)).toBe(true);
	});

	it("undo / redo はテーブル末尾退避フィルタを通らず履歴上の状態を忠実に復元する（#90）", () => {
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		let state = EditorState.create({
			doc: `${simpleTable}\ntext`,
			selection: EditorSelection.cursor(0),
			extensions: [history(), markdown({ base: markdownLanguage }), tableDecoration],
		});
		ensureSyntaxTree(state, state.doc.length, Number.POSITIVE_INFINITY);
		state = state.update({}).state;
		const view = new EditorView({ state, parent });
		mounted.push(view);

		// "text" 行末 → Backspace 相当でテーブル末尾境界を作る操作。filter は dodge する。
		const tableEnd = view.state.doc.line(3).to;
		view.dispatch({ changes: { from: tableEnd, to: tableEnd + "\ntext".length } });
		expect(view.state.doc.toString()).toBe(simpleTable);

		// undo: 履歴の状態（"text" 行が復活）を忠実に復元し、dodge による余計な改行や
		// カーソル移動を起こさない
		undo(view);
		expect(view.state.doc.toString()).toBe(`${simpleTable}\ntext`);

		// redo: 元の状態へ戻す（こちらも dodge しない）
		redo(view);
		expect(view.state.doc.toString()).toBe(simpleTable);
	});

	it("削除でテーブル末尾境界(EOF)に取り残されたら同期で改行を補い退避する", () => {
		const view = mountEditor(`${simpleTable}\n`); // テーブル + 直下に 1 行
		const endTo = view.state.doc.line(3).to; // テーブル最終行末尾

		// 直下の改行を削除し、カーソルを EOF 境界(endTo)へ（空行先頭からの Backspace 相当）
		view.dispatch({ changes: { from: endTo, to: endTo + 1 }, selection: { anchor: endTo } });

		// docChanged トランザクションでも filter が同期で改行を補完し、直下行へ退避する
		// （queueMicrotask 待ちは不要）
		expect(view.state.doc.toString()).toBe(`${simpleTable}\n`);
		expect(view.state.selection.main.head).toBe(endTo + 1);
	});

	it("テーブル直下の空行を削除して本文を密着させると、カーソルは本文行頭へ退避する（#90）", () => {
		// ユーザー報告シナリオ: テーブル + 空行 + 本文。空行を消して本文をテーブル直下へ。
		const doc = `${simpleTable}\n\ntext`;
		const view = mountEditor(doc);
		const endTo = view.state.doc.line(3).to; // テーブル最終行末尾

		// 空行(line4)を削除して本文をテーブル直下へ（境界に取り残されるはずの操作）
		view.dispatch({ changes: { from: endTo, to: endTo + 1 }, selection: { anchor: endTo } });

		// 直下に本文行があるので改行は補わず、カーソルだけ本文行頭(endTo+1)へ退避
		expect(view.state.doc.toString()).toBe(`${simpleTable}\ntext`);
		expect(view.state.selection.main.head).toBe(endTo + 1);
		expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("text");
	});

	it("退避が削除をまたぐ docChanged でも undo / redo が正しく機能する（#90）", () => {
		const doc = `${simpleTable}\n\ntext`;
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		let state = EditorState.create({
			doc,
			selection: EditorSelection.cursor(0),
			extensions: [history(), markdown({ base: markdownLanguage }), tableDecoration],
		});
		ensureSyntaxTree(state, state.doc.length, Number.POSITIVE_INFINITY);
		state = state.update({}).state;
		const view = new EditorView({ state, parent });
		mounted.push(view);

		const endTo = view.state.doc.line(3).to;
		view.dispatch({ changes: { from: endTo, to: endTo + 1 }, selection: { anchor: endTo } });
		expect(view.state.doc.toString()).toBe(`${simpleTable}\ntext`);

		// 退避を含む再構築トランザクションも history に積まれ、undo で元に戻る
		undo(view);
		expect(view.state.doc.toString()).toBe(doc);
		redo(view);
		expect(view.state.doc.toString()).toBe(`${simpleTable}\ntext`);
	});

	it("テーブルでないパイプ行の行末では退避しない（誤検知防止, #90）", () => {
		// header + delimiter が揃わない単独パイプ行は widget 化されないので退避もしない
		const view = mountEditor("| not a table\nmore");
		const line1End = view.state.doc.line(1).to;
		view.dispatch({ selection: { anchor: line1End } });
		expect(view.state.selection.main.head).toBe(line1End);
		expect(view.state.doc.toString()).toBe("| not a table\nmore");
	});
});

// ── multi-cell selection (#119) ──

describe("multi-cell selection (#119)", () => {
	const mounted: EditorView[] = [];

	afterEach(() => {
		while (mounted.length > 0) {
			mounted.pop()?.destroy();
		}
	});

	function mountEditor(doc: string): EditorView {
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		let state = EditorState.create({
			doc,
			selection: EditorSelection.cursor(0),
			extensions: [markdown({ base: markdownLanguage }), tableDecoration],
		});
		ensureSyntaxTree(state, state.doc.length, Number.POSITIVE_INFINITY);
		state = state.update({}).state;
		const view = new EditorView({ state, parent });
		view.focus();
		mounted.push(view);
		return view;
	}

	function getWrapper(view: EditorView): HTMLElement {
		return view.dom.querySelector(".cm-table-widget") as HTMLElement;
	}

	function getCell(wrapper: HTMLElement, row: number, col: number): HTMLElement {
		return wrapper.querySelector(`[data-row="${row}"][data-col="${col}"]`) as HTMLElement;
	}

	function click(cell: HTMLElement): void {
		cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		cell.focus();
	}

	function shiftClick(cell: HTMLElement): void {
		cell.dispatchEvent(
			new MouseEvent("mousedown", { bubbles: true, cancelable: true, shiftKey: true }),
		);
	}

	function selectedCount(wrapper: HTMLElement): number {
		return wrapper.querySelectorAll(".cm-table-cell-selected").length;
	}

	it("Shift+click でフォーカス中セルから矩形選択が適用される", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);
		const cellA = getCell(wrapper, 0, 0);
		const cellB = getCell(wrapper, 1, 1);

		click(cellA);
		shiftClick(cellB);

		expect(selectedCount(wrapper)).toBe(4);
		expect(cellA.classList.contains("cm-table-cell-selected")).toBe(true);
		expect(cellB.classList.contains("cm-table-cell-selected")).toBe(true);
	});

	it("Shift+click で既存選択のアンカーを維持して拡張する", () => {
		const table = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |";
		const view = mountEditor(table);
		const wrapper = getWrapper(view);

		click(getCell(wrapper, 0, 0));
		shiftClick(getCell(wrapper, 1, 1));
		expect(selectedCount(wrapper)).toBe(4);

		shiftClick(getCell(wrapper, 2, 2));
		expect(selectedCount(wrapper)).toBe(9);
	});

	it("通常クリック（mousedown）でセル選択がクリアされる", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);

		click(getCell(wrapper, 0, 0));
		shiftClick(getCell(wrapper, 1, 1));
		expect(selectedCount(wrapper)).toBe(4);

		getCell(wrapper, 0, 0).dispatchEvent(
			new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
		);
		expect(selectedCount(wrapper)).toBe(0);
	});

	it("Escape でセル選択がクリアされる", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);
		const cell = getCell(wrapper, 0, 0);

		click(cell);
		shiftClick(getCell(wrapper, 1, 1));
		expect(selectedCount(wrapper)).toBe(4);

		cell.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
		);
		expect(selectedCount(wrapper)).toBe(0);
	});

	it("Delete で選択セルの内容がクリアされドキュメントに反映される", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);
		const cell = getCell(wrapper, 0, 0);

		click(cell);
		shiftClick(getCell(wrapper, 1, 1));

		cell.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
		);

		expect(selectedCount(wrapper)).toBe(0);
		expect(view.state.doc.line(1).text).toBe("|  |  |");
		expect(view.state.doc.line(3).text).toBe("|  |  |");
	});

	it("Backspace で選択セルの内容がクリアされる", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);
		const cell = getCell(wrapper, 0, 0);

		click(cell);
		shiftClick(getCell(wrapper, 1, 1));

		cell.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
		);

		expect(selectedCount(wrapper)).toBe(0);
		expect(view.state.doc.line(1).text).toBe("|  |  |");
	});

	it("通常キー入力でセル選択がクリアされ通常編集に戻る", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);
		const cell = getCell(wrapper, 0, 0);

		click(cell);
		shiftClick(getCell(wrapper, 1, 1));
		expect(selectedCount(wrapper)).toBe(4);

		cell.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
		expect(selectedCount(wrapper)).toBe(0);
	});

	it("Cmd+A でマルチセル選択時にテーブル全セルが選択される", () => {
		const table = "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |";
		const view = mountEditor(table);
		const wrapper = getWrapper(view);

		click(getCell(wrapper, 0, 0));
		shiftClick(getCell(wrapper, 0, 1));
		expect(selectedCount(wrapper)).toBe(2);

		getCell(wrapper, 0, 0).dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "a",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(selectedCount(wrapper)).toBe(9);
	});

	it("Cmd+A でマルチセル選択が無い場合はセル内容を選択する（既存動作維持）", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);
		const cell = getCell(wrapper, 0, 0);
		cell.focus();

		cell.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "a",
				metaKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);

		expect(selectedCount(wrapper)).toBe(0);
		expect(window.getSelection()?.toString()).toBe("A");
	});

	it("clearCellSelection で選択状態が完全にクリアされる", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);

		click(getCell(wrapper, 0, 0));
		shiftClick(getCell(wrapper, 1, 1));
		expect(selectedCount(wrapper)).toBe(4);

		clearCellSelection(wrapper);
		expect(selectedCount(wrapper)).toBe(0);
	});

	it("Cmd+C でマルチセル選択が無い場合は preventDefault されない（native copy 維持）", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);
		const cell = getCell(wrapper, 0, 0);
		click(cell);

		const ev = new KeyboardEvent("keydown", {
			key: "c",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		cell.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(false);
	});

	it("Cmd+C でマルチセル選択時は preventDefault される（カスタムコピー）", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);
		const cell = getCell(wrapper, 0, 0);

		click(cell);
		shiftClick(getCell(wrapper, 1, 1));

		const ev = new KeyboardEvent("keydown", {
			key: "c",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		cell.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
	});

	it("Cmd+C の TSV に <br> リテラルが含まれず改行としてクォートされる", () => {
		const tableWithBr = `| A | B |
| --- | --- |
| hello<br>world | x |`;
		const view = mountEditor(tableWithBr);
		const wrapper = getWrapper(view);
		const cell00 = getCell(wrapper, 0, 0);
		const cell10 = getCell(wrapper, 1, 1);

		click(cell00);
		shiftClick(cell10);

		let copied = "";
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: (t: string) => {
					copied = t;
					return Promise.resolve();
				},
			},
			writable: true,
			configurable: true,
		});

		const ev = new KeyboardEvent("keydown", {
			key: "c",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		cell00.dispatchEvent(ev);

		expect(copied).not.toContain("<br>");
		expect(copied).toBe('A\tB\n"hello\nworld"\tx');
	});

	it("Cmd+X でマルチセル選択時は preventDefault + セル内容クリア", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);
		const cell = getCell(wrapper, 0, 0);

		click(cell);
		shiftClick(getCell(wrapper, 1, 1));

		const ev = new KeyboardEvent("keydown", {
			key: "x",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		cell.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		expect(view.state.doc.line(1).text).toBe("|  |  |");
		expect(view.state.doc.line(3).text).toBe("|  |  |");
	});

	it("Cmd+C で空セルを含むコピーに不要な改行が入らない", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);
		const cell00 = getCell(wrapper, 0, 0);
		const cell11 = getCell(wrapper, 1, 1);

		cell00.textContent = "";
		cell00.appendChild(document.createElement("br"));

		click(cell00);
		shiftClick(cell11);

		let copied = "";
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: (t: string) => {
					copied = t;
					return Promise.resolve();
				},
			},
			writable: true,
			configurable: true,
		});

		const ev = new KeyboardEvent("keydown", {
			key: "c",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		cell00.dispatchEvent(ev);

		expect(copied).toBe("\tB\n1\t2");
	});

	it("TSV ペーストで複数セルに展開される", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);
		const cell = getCell(wrapper, 0, 0);
		click(cell);

		const tsv = "X\tY\nZ\tW";
		const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(pasteEvent, "clipboardData", {
			value: { getData: () => tsv },
		});
		cell.dispatchEvent(pasteEvent);

		expect(view.state.doc.line(1).text).toBe("| X | Y |");
		expect(view.state.doc.line(3).text).toBe("| Z | W |");
	});

	it("マルチセル選択中の plain text ペーストが選択矩形の左上セルに挿入される", () => {
		const view = mountEditor(simpleTable);
		const wrapper = getWrapper(view);

		click(getCell(wrapper, 1, 1));
		shiftClick(getCell(wrapper, 0, 0));

		const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(pasteEvent, "clipboardData", {
			value: { getData: () => "PASTED" },
		});
		getCell(wrapper, 1, 1).dispatchEvent(pasteEvent);

		expect(getCell(wrapper, 0, 0).textContent).toBe("PASTED");
		expect(view.state.doc.line(1).text).toBe("| PASTED | B |");
		expect(view.state.doc.line(3).text).toBe("| 1 | 2 |");
	});
});

describe("parseTsv", () => {
	it("基本的な TSV をパースする", () => {
		expect(parseTsv("A\tB\n1\t2")).toEqual([
			["A", "B"],
			["1", "2"],
		]);
	});

	it("クォートされたフィールドを処理する", () => {
		expect(parseTsv('"hello\nworld"\tx')).toEqual([["hello\nworld", "x"]]);
	});

	it("エスケープされたダブルクォートを処理する", () => {
		expect(parseTsv('"say ""hi"""\tB')).toEqual([['say "hi"', "B"]]);
	});

	it("末尾の改行を無視する", () => {
		expect(parseTsv("A\tB\n")).toEqual([["A", "B"]]);
	});

	it("空セルを保持する", () => {
		expect(parseTsv("A\t\tC")).toEqual([["A", "", "C"]]);
	});

	it("CRLF を処理する", () => {
		expect(parseTsv("A\tB\r\n1\t2")).toEqual([
			["A", "B"],
			["1", "2"],
		]);
	});
});
