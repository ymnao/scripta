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
			const view = mountTable(`${INTRO}${TABLE}`);
			choose(view, 1, 0, "下に行を追加");
			expect(view.state.doc.toString()).toBe(
				`${INTRO}${[HEADER, DELIM, ROW1, EMPTY, ROW2].join("\n")}`,
			);
		});

		it("ヘッダ行で「下に行を追加」すると、区切り行の直後に空の行が入る", () => {
			const view = mountTable(`${INTRO}${TABLE}`);
			choose(view, 0, 0, "下に行を追加");
			expect(view.state.doc.toString()).toBe(
				`${INTRO}${[HEADER, DELIM, EMPTY, ROW1, ROW2].join("\n")}`,
			);
		});

		it("データ行で「上に行を追加」すると、その行の直前に空の行が入る", () => {
			const view = mountTable(`${INTRO}${TABLE}`);
			choose(view, 2, 0, "上に行を追加");
			expect(view.state.doc.toString()).toBe(
				`${INTRO}${[HEADER, DELIM, ROW1, EMPTY, ROW2].join("\n")}`,
			);
		});

		it("ヘッダ行では「上に行を追加」が無効で、選んでも文書は変わらない", () => {
			const view = mountTable(`${INTRO}${TABLE}`);
			choose(view, 0, 0, "上に行を追加");
			expect(view.state.doc.toString()).toBe(`${INTRO}${TABLE}`);
			expect(openMenus()).toBe(1);
		});

		it("データ行で「行を削除」すると、その行だけが消える", () => {
			const view = mountTable(`${INTRO}${TABLE}`);
			choose(view, 1, 0, "行を削除");
			expect(view.state.doc.toString()).toBe(`${INTRO}${[HEADER, DELIM, ROW2].join("\n")}`);
		});

		it("ヘッダ行では「行を削除」が無効で、選んでも文書は変わらない", () => {
			const view = mountTable(`${INTRO}${TABLE}`);
			choose(view, 0, 0, "行を削除");
			expect(view.state.doc.toString()).toBe(`${INTRO}${TABLE}`);
		});

		it("データ行が 1 行だけのときは「行を削除」が無効で、選んでも文書は変わらない", () => {
			const doc = `${INTRO}${[HEADER, DELIM, ROW1].join("\n")}`;
			const view = mountTable(doc);
			choose(view, 1, 0, "行を削除");
			expect(view.state.doc.toString()).toBe(doc);
		});
	});

	describe("列の操作", () => {
		// 行と列の番号が同じセルだと、行番号を列として読んでも結果が変わらない
		it("「左に列を追加」すると、全行のその列の前に空のセルが入り、区切り行には --- が入る", () => {
			const view = mountTable(`${INTRO}${TABLE}`);
			choose(view, 2, 1, "左に列を追加");
			expect(view.state.doc.toString()).toBe(
				`${INTRO}${[
					"| A |  | B | C |",
					"| --- | --- | --- | --- |",
					"| 1 |  | 2 | 3 |",
					"| 4 |  | 5 | 6 |",
				].join("\n")}`,
			);
		});

		it("「右に列を追加」すると、全行のその列の後に空のセルが入る", () => {
			const view = mountTable(`${INTRO}${TABLE}`);
			choose(view, 2, 1, "右に列を追加");
			expect(view.state.doc.toString()).toBe(
				`${INTRO}${[
					"| A | B |  | C |",
					"| --- | --- | --- | --- |",
					"| 1 | 2 |  | 3 |",
					"| 4 | 5 |  | 6 |",
				].join("\n")}`,
			);
		});

		it("「列を削除」すると、全行からその列が消える", () => {
			const view = mountTable(`${INTRO}${TABLE}`);
			choose(view, 2, 1, "列を削除");
			expect(view.state.doc.toString()).toBe(
				`${INTRO}${["| A | C |", "| --- | --- |", "| 1 | 3 |", "| 4 | 6 |"].join("\n")}`,
			);
		});

		it("2 列以下のときは「列を削除」が無効で、選んでも文書は変わらない", () => {
			const doc = `${INTRO}${["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n")}`;
			const view = mountTable(doc);
			choose(view, 1, 0, "列を削除");
			expect(view.state.doc.toString()).toBe(doc);
		});
	});

	describe("テーブルの削除", () => {
		// 表の上下が空行なしで他の行に接するケースは #667 の不具合があるので、
		// 直したあとも結果が変わらない文書の先頭・末尾だけを固定する
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
			const view = mountTable(`${INTRO}${TABLE}`);
			choose(view, 1, 0, "下に行を追加");
			expect(openMenus()).toBe(0);
		});

		it("Escape でメニューが閉じ、文書は変わらない", async () => {
			const view = mountTable(`${INTRO}${TABLE}`);
			openMenu(view, 1, 0);
			await waitForMenuListeners();
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			expect(openMenus()).toBe(0);
			expect(view.state.doc.toString()).toBe(`${INTRO}${TABLE}`);
		});

		it("メニューの外を押すとメニューが閉じる", async () => {
			const view = mountTable(`${INTRO}${TABLE}`);
			openMenu(view, 1, 0);
			await waitForMenuListeners();
			document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			expect(openMenus()).toBe(0);
		});

		it("メニューの中を押しても閉じない", async () => {
			const view = mountTable(`${INTRO}${TABLE}`);
			const menu = openMenu(view, 1, 0);
			await waitForMenuListeners();
			menu.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
			expect(openMenus()).toBe(1);
		});

		it("開いたまま別のセルで開き直すと、メニューは 1 つだけになる", () => {
			const view = mountTable(`${INTRO}${TABLE}`);
			openMenu(view, 1, 0);
			openMenu(view, 2, 1);
			expect(openMenus()).toBe(1);
		});
	});
});
