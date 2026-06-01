import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildTableDecorations,
	exitTableDown,
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

	function mountEditor(doc: string, cursorPos = 0): EditorView {
		const parent = document.createElement("div");
		document.body.appendChild(parent);
		let state = EditorState.create({
			doc,
			selection: EditorSelection.cursor(cursorPos),
			extensions: [markdown({ base: markdownLanguage }), tableDecoration],
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

	it("削除でテーブル末尾境界(EOF)に取り残されたら改行を補い退避する（tableBoundaryGuard）", async () => {
		const view = mountEditor(`${simpleTable}\n`); // テーブル + 直下に 1 行
		const endTo = view.state.doc.line(3).to; // テーブル最終行末尾

		// 直下の改行を削除し、カーソルを EOF 境界(endTo)へ（空行先頭からの Backspace 相当）
		view.dispatch({ changes: { from: endTo, to: endTo + 1 }, selection: { anchor: endTo } });

		// 削除直後はテーブル末尾境界（巨大キャレット位置）に取り残される
		expect(view.state.doc.toString()).toBe(simpleTable);
		expect(view.state.selection.main.head).toBe(endTo);

		// guard が次 tick で改行を補完し、テーブル直下の行へ退避する
		await new Promise<void>((resolve) => queueMicrotask(resolve));

		expect(view.state.doc.toString()).toBe(`${simpleTable}\n`);
		expect(view.state.selection.main.head).toBe(endTo + 1);
	});
});
