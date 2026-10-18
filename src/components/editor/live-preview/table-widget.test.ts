import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { tableDecoration } from "./table-decoration";
import { cleanupMountedViews, mountEditorView } from "./test-helper";

// 表の前に行を置き、行番号を表の開始行から数えていることも見る
const INTRO = "intro\n\n";
const HEADER = "| A | B | C |";
const DELIM = "| --- | --- | --- |";
const ROW1 = "| 1 | 2 | 3 |";
const ROW2 = "| 4 | 5 | 6 |";
const EMPTY = "|    |    |    |";
const TABLE = [HEADER, DELIM, ROW1, ROW2].join("\n");
const DOC = withIntro(TABLE);

function withIntro(...lines: string[]): string {
	return `${INTRO}${lines.join("\n")}`;
}

function mountTable(doc: string): EditorView {
	return mountEditorView(doc, tableDecoration, 0);
}

function cellAt(view: EditorView, row: number, col: number): HTMLElement {
	const cell = view.dom.querySelector<HTMLElement>(
		`.cm-table-widget [data-row="${row}"][data-col="${col}"]`,
	);
	if (!cell) throw new Error(`cell (${row}, ${col}) not found`);
	return cell;
}

function openMenu(view: EditorView, row: number, col: number): HTMLElement {
	cellAt(view, row, col).dispatchEvent(
		new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
	);
	const menu = document.querySelector<HTMLElement>(".cm-table-context-menu");
	if (!menu) throw new Error("context menu not shown");
	return menu;
}

function menuItem(menu: HTMLElement, label: string): HTMLElement {
	const item = Array.from(menu.children).find((el) => el.textContent === label);
	if (!(item instanceof HTMLElement)) throw new Error(`menu item "${label}" not found`);
	return item;
}

function choose(view: EditorView, row: number, col: number, label: string): void {
	menuItem(openMenu(view, row, col), label).dispatchEvent(
		new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
	);
}

/** 無効な項目のテストで文書だけを見ないのは、関数の側にも同じガードがあり、無効の
 *  指定が外れても文書は変わらないため。無効な項目は押してもメニューが閉じない */
function openMenus(): number {
	return document.querySelectorAll(".cm-table-context-menu").length;
}

/** メニューを閉じる document の listener は setTimeout で遅れて付く */
function waitForMenuListeners(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve));
}

describe("表のコンテキストメニュー", () => {
	// 閉じ方を 1 つにしないのは、その閉じ方が効かないときにメニューが次の test に
	// 残り、querySelector が古いメニューを拾って無関係な test まで落ちるため
	afterEach(async () => {
		await waitForMenuListeners();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		for (const menu of document.querySelectorAll(".cm-table-context-menu")) menu.remove();
		cleanupMountedViews();
	});

	describe("行の操作", () => {
		it("データ行で「下に行を追加」すると、その行の直後に空の行が入る", () => {
			const view = mountTable(DOC);
			choose(view, 1, 0, "下に行を追加");
			expect(view.state.doc.toString()).toBe(withIntro(HEADER, DELIM, ROW1, EMPTY, ROW2));
		});

		it("文書の末尾にある最後の行で「下に行を追加」すると、文書の末尾に空の行が入る", () => {
			const view = mountTable(DOC);
			choose(view, 2, 0, "下に行を追加");
			expect(view.state.doc.toString()).toBe(withIntro(HEADER, DELIM, ROW1, ROW2, EMPTY));
		});

		it("ヘッダ行で「下に行を追加」すると、区切り行の直後に空の行が入る", () => {
			const view = mountTable(DOC);
			choose(view, 0, 0, "下に行を追加");
			expect(view.state.doc.toString()).toBe(withIntro(HEADER, DELIM, EMPTY, ROW1, ROW2));
		});

		it("データ行で「上に行を追加」すると、その行の直前に空の行が入る", () => {
			const view = mountTable(DOC);
			choose(view, 2, 0, "上に行を追加");
			expect(view.state.doc.toString()).toBe(withIntro(HEADER, DELIM, ROW1, EMPTY, ROW2));
		});

		it("ヘッダ行では「上に行を追加」が無効で、選んでもメニューは閉じず文書も変わらない", () => {
			const view = mountTable(DOC);
			choose(view, 0, 0, "上に行を追加");
			expect(openMenus()).toBe(1);
			expect(view.state.doc.toString()).toBe(DOC);
		});

		it("データ行で「行を削除」すると、その行だけが消える", () => {
			const view = mountTable(DOC);
			choose(view, 1, 0, "行を削除");
			expect(view.state.doc.toString()).toBe(withIntro(HEADER, DELIM, ROW2));
		});

		it("文書の末尾にある最後の行で「行を削除」すると、その行と直前の改行が消える", () => {
			const view = mountTable(DOC);
			choose(view, 2, 0, "行を削除");
			expect(view.state.doc.toString()).toBe(withIntro(HEADER, DELIM, ROW1));
		});

		it("ヘッダ行では「行を削除」が無効で、選んでもメニューは閉じず文書も変わらない", () => {
			const view = mountTable(DOC);
			choose(view, 0, 0, "行を削除");
			expect(openMenus()).toBe(1);
			expect(view.state.doc.toString()).toBe(DOC);
		});

		it("データ行が 1 行だけのときは「行を削除」が無効で、選んでもメニューは閉じず文書も変わらない", () => {
			const doc = withIntro(HEADER, DELIM, ROW1);
			const view = mountTable(doc);
			choose(view, 1, 0, "行を削除");
			expect(openMenus()).toBe(1);
			expect(view.state.doc.toString()).toBe(doc);
		});
	});

	describe("列の操作", () => {
		// 行と列の番号が同じセルだと、行番号を列として読んでも結果が変わらない
		it("「左に列を追加」すると、全行のその列の前に空のセルが入り、区切り行には --- が入る", () => {
			const view = mountTable(DOC);
			choose(view, 2, 1, "左に列を追加");
			expect(view.state.doc.toString()).toBe(
				withIntro(
					"| A |  | B | C |",
					"| --- | --- | --- | --- |",
					"| 1 |  | 2 | 3 |",
					"| 4 |  | 5 | 6 |",
				),
			);
		});

		it("「右に列を追加」すると、全行のその列の後に空のセルが入る", () => {
			const view = mountTable(DOC);
			choose(view, 2, 1, "右に列を追加");
			expect(view.state.doc.toString()).toBe(
				withIntro(
					"| A | B |  | C |",
					"| --- | --- | --- | --- |",
					"| 1 | 2 |  | 3 |",
					"| 4 | 5 |  | 6 |",
				),
			);
		});

		it("「列を削除」すると、全行からその列が消える", () => {
			const view = mountTable(DOC);
			choose(view, 2, 1, "列を削除");
			expect(view.state.doc.toString()).toBe(
				withIntro("| A | C |", "| --- | --- |", "| 1 | 3 |", "| 4 | 6 |"),
			);
		});

		it("2 列以下のときは「列を削除」が無効で、選んでもメニューは閉じず文書も変わらない", () => {
			const doc = withIntro("| A | B |", "| --- | --- |", "| 1 | 2 |");
			const view = mountTable(doc);
			choose(view, 1, 0, "列を削除");
			expect(openMenus()).toBe(1);
			expect(view.state.doc.toString()).toBe(doc);
		});
	});

	describe("テーブルの削除", () => {
		// 表の上下が空行なしで他の行に接するケースは #667 の不具合があるので固定しない。
		// 文書の先頭・末尾は、#667 を「前後の改行のうち存在する方を 1 つだけ消す」形で直すなら
		// 結果が変わらない
		it("文書の先頭にある表を削除すると、表と直後の改行が消える", () => {
			const view = mountTable(`${TABLE}\n# h2`);
			choose(view, 1, 0, "テーブルを削除");
			expect(view.state.doc.toString()).toBe("# h2");
		});

		it("文書の末尾にある表を削除すると、表と直前の改行が消える", () => {
			const view = mountTable(`# h\n${TABLE}`);
			choose(view, 1, 0, "テーブルを削除");
			expect(view.state.doc.toString()).toBe("# h");
		});
	});

	describe("メニューの開閉", () => {
		it("項目を選ぶとメニューが閉じる", () => {
			const view = mountTable(DOC);
			choose(view, 1, 0, "下に行を追加");
			expect(openMenus()).toBe(0);
		});

		it("Escape でメニューが閉じ、文書は変わらない", async () => {
			const view = mountTable(DOC);
			openMenu(view, 1, 0);
			await waitForMenuListeners();
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			expect(openMenus()).toBe(0);
			expect(view.state.doc.toString()).toBe(DOC);
		});

		it("メニューの外を押すとメニューが閉じる", async () => {
			const view = mountTable(DOC);
			openMenu(view, 1, 0);
			await waitForMenuListeners();
			document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			expect(openMenus()).toBe(0);
		});

		it("メニューの中を押しても閉じない", async () => {
			const view = mountTable(DOC);
			const menu = openMenu(view, 1, 0);
			await waitForMenuListeners();
			menu.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			expect(openMenus()).toBe(1);
		});

		it("開いたまま別のセルで開き直すと、メニューは 1 つだけになる", () => {
			const view = mountTable(DOC);
			openMenu(view, 1, 0);
			openMenu(view, 2, 1);
			expect(openMenus()).toBe(1);
		});
	});
});
