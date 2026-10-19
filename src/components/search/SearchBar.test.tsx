import { getSearchQuery, search, searchPanelOpen } from "@codemirror/search";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cleanupMountedViews,
	createTestState,
	mountEditorView,
} from "../editor/live-preview/test-helper";
import { SearchBar, type SearchBarHandle } from "./SearchBar";

afterEach(cleanupMountedViews);

function mountView(doc: string): EditorView {
	return mountEditorView(doc, search());
}

function replaceState(view: EditorView, doc: string): void {
	act(() => {
		view.setState(createTestState(doc, undefined, search()));
	});
}

function renderBar(view: EditorView, props: Partial<Parameters<typeof SearchBar>[0]> = {}) {
	const onClose = vi.fn();
	const result = render(<SearchBar view={view} onClose={onClose} {...props} />);
	return { ...result, onClose };
}

function searchInput(): HTMLInputElement {
	return screen.getByRole("textbox", { name: "検索" });
}

function replaceInput(): HTMLInputElement {
	return screen.getByRole("textbox", { name: "置換" });
}

function matchCount(): HTMLElement {
	const el = document.querySelector<HTMLElement>(".search-bar-match-count");
	if (!el) throw new Error("match count not found");
	return el;
}

function selected(view: EditorView): { from: number; to: number } {
	const { from, to } = view.state.selection.main;
	return { from, to };
}

function select(view: EditorView, from: number, to: number): void {
	act(() => {
		view.dispatch({ selection: EditorSelection.single(from, to) });
	});
}

// isIMEComposing は isComposing と keyCode 229 のどちらかで変換中とみなすので、片方ずつ撃つ
const IME = [
	{ how: "keyCode 229", init: { keyCode: 229 } },
	{ how: "isComposing", init: { isComposing: true } },
];

describe("件数表示", () => {
	it("検索欄が空なら何も出さない", () => {
		renderBar(mountView("foo"));

		expect(matchCount()).toHaveTextContent(/^$/);
	});

	it("一致が無いと No results", () => {
		renderBar(mountView("foo"), { initialSearchText: "bar" });

		expect(matchCount()).toHaveTextContent(/^No results$/);
	});

	it("選択が一致に重なっていないと件数だけ出す", () => {
		renderBar(mountView("x foo foo foo"), { initialSearchText: "foo" });

		expect(matchCount()).toHaveTextContent(/^3 results$/);
	});

	it("選択が一致と同じ範囲なら何件目かを出す", () => {
		const view = mountView("foo foo foo");
		renderBar(view, { initialSearchText: "foo" });

		select(view, 4, 7);

		expect(matchCount()).toHaveTextContent(/^2 of 3$/);
	});

	it("選択が一致と始点だけ同じなら何件目かを出さない", () => {
		const view = mountView("foo foo foo");
		renderBar(view, { initialSearchText: "foo" });

		select(view, 4, 6);

		expect(matchCount()).toHaveTextContent(/^3 results$/);
	});

	it("選択が一致と終点だけ同じなら何件目かを出さない", () => {
		const view = mountView("foo foo foo");
		renderBar(view, { initialSearchText: "foo" });

		select(view, 5, 7);

		expect(matchCount()).toHaveTextContent(/^3 results$/);
	});

	it("9999 件ちょうどは件数をそのまま出す", () => {
		renderBar(mountView("a".repeat(9999)), { initialSearchText: "a" });

		expect(matchCount()).toHaveTextContent(/^9999 results$/);
	});

	it("10000 件以上は 9999+ と出す", () => {
		renderBar(mountView("a".repeat(10001)), { initialSearchText: "a" });

		expect(matchCount()).toHaveTextContent(/^9999\+$/);
	});

	it("入力するたびに CodeMirror の検索クエリと件数を更新する", async () => {
		const view = mountView("fo foo foo");
		renderBar(view);

		await userEvent.type(searchInput(), "fo");
		expect(getSearchQuery(view.state).search).toBe("fo");
		expect(matchCount()).toHaveTextContent(/^3 results$/);

		await userEvent.type(searchInput(), "o");
		expect(getSearchQuery(view.state).search).toBe("foo");
		expect(matchCount()).toHaveTextContent(/^2 results$/);
	});
});

describe("一致の間の移動", () => {
	it("次の一致ボタンで次の一致を選び、何件目かを出す", async () => {
		const view = mountView("foo bar foo");
		renderBar(view, { initialSearchText: "foo" });

		await userEvent.click(screen.getByRole("button", { name: "次の一致" }));
		expect(selected(view)).toEqual({ from: 0, to: 3 });
		await waitFor(() => expect(matchCount()).toHaveTextContent(/^1 of 2$/));

		await userEvent.click(screen.getByRole("button", { name: "次の一致" }));
		expect(selected(view)).toEqual({ from: 8, to: 11 });
		await waitFor(() => expect(matchCount()).toHaveTextContent(/^2 of 2$/));
	});

	// 一致が 2 件だと、前へ戻る代わりに次へ進んで折り返しても同じ位置に着くので 3 件にする
	it("前の一致ボタンで前の一致を選ぶ", async () => {
		const view = mountView("foo foo foo");
		renderBar(view, { initialSearchText: "foo" });
		select(view, 8, 11);

		await userEvent.click(screen.getByRole("button", { name: "前の一致" }));

		expect(selected(view)).toEqual({ from: 4, to: 7 });
		await waitFor(() => expect(matchCount()).toHaveTextContent(/^2 of 3$/));
	});

	it("検索欄の Enter で次へ、Shift+Enter で前へ移動する", async () => {
		const view = mountView("foo foo foo");
		renderBar(view, { initialSearchText: "foo" });

		await userEvent.type(searchInput(), "{Enter}");
		expect(selected(view)).toEqual({ from: 0, to: 3 });

		await userEvent.type(searchInput(), "{Enter}");
		expect(selected(view)).toEqual({ from: 4, to: 7 });

		await userEvent.type(searchInput(), "{Enter}");
		expect(selected(view)).toEqual({ from: 8, to: 11 });

		await userEvent.type(searchInput(), "{Shift>}{Enter}{/Shift}");
		expect(selected(view)).toEqual({ from: 4, to: 7 });
	});

	it.each(IME)("IME 変換中（$how）の Enter では移動しない", ({ init }) => {
		const view = mountView("foo bar foo");
		renderBar(view, { initialSearchText: "foo" });

		fireEvent.keyDown(searchInput(), { key: "Enter", ...init });

		expect(selected(view)).toEqual({ from: 0, to: 0 });
	});

	it("検索欄が空なら Enter で何もしない", async () => {
		const view = mountView("foo");
		renderBar(view);

		await userEvent.type(searchInput(), "{Enter}");
		await userEvent.type(searchInput(), "{Shift>}{Enter}{/Shift}");

		expect(selected(view)).toEqual({ from: 0, to: 0 });
		// 空のクエリで findNext / findPrevious を呼ぶと CodeMirror 自身の検索パネルが開く
		expect(searchPanelOpen(view.state)).toBe(false);
	});

	// 押しても動かないことは見ない。一致が無ければ findNext / findPrevious 自体が何もしない
	it("一致が無いと前後のボタンは無効になる", () => {
		renderBar(mountView("foo"), { initialSearchText: "bar" });

		for (const name of ["前の一致", "次の一致"]) {
			expect(screen.getByRole("button", { name })).toHaveAttribute("aria-disabled", "true");
		}
	});

	it("一致があると前後のボタンは有効", () => {
		renderBar(mountView("foo"), { initialSearchText: "foo" });

		for (const name of ["前の一致", "次の一致"]) {
			expect(screen.getByRole("button", { name })).not.toHaveAttribute("aria-disabled");
		}
	});
});

describe("置換", () => {
	it("置換ボタンで選択中の一致を置換し、次の一致を選ぶ", async () => {
		const view = mountView("foo bar foo");
		renderBar(view, { initialExpanded: true, initialSearchText: "foo" });
		await userEvent.type(replaceInput(), "baz");
		select(view, 0, 3);

		await userEvent.click(screen.getByRole("button", { name: "置換" }));

		expect(view.state.doc.toString()).toBe("baz bar foo");
		expect(selected(view)).toEqual({ from: 8, to: 11 });
		await waitFor(() => expect(matchCount()).toHaveTextContent(/^1 of 1$/));
	});

	it("置換欄の Enter で置換する", async () => {
		const view = mountView("foo bar foo");
		renderBar(view, { initialExpanded: true, initialSearchText: "foo" });
		await userEvent.type(replaceInput(), "baz");
		select(view, 0, 3);

		await userEvent.type(replaceInput(), "{Enter}");

		expect(view.state.doc.toString()).toBe("baz bar foo");
	});

	it.each(IME)("IME 変換中（$how）の置換欄の Enter では置換しない", async ({ init }) => {
		const view = mountView("foo bar foo");
		renderBar(view, { initialExpanded: true, initialSearchText: "foo" });
		await userEvent.type(replaceInput(), "baz");
		select(view, 0, 3);

		fireEvent.keyDown(replaceInput(), { key: "Enter", ...init });

		expect(view.state.doc.toString()).toBe("foo bar foo");
	});

	it("検索欄が空なら置換欄の Enter で何もしない", async () => {
		const view = mountView("foo");
		renderBar(view, { initialExpanded: true });

		await userEvent.type(replaceInput(), "{Enter}");

		expect(view.state.doc.toString()).toBe("foo");
		expect(searchPanelOpen(view.state)).toBe(false);
	});

	it("すべて置換で全部の一致を置換する", async () => {
		const view = mountView("foo bar foo");
		renderBar(view, { initialExpanded: true, initialSearchText: "foo" });
		await userEvent.type(replaceInput(), "baz");

		await userEvent.click(screen.getByRole("button", { name: "すべて置換" }));

		expect(view.state.doc.toString()).toBe("baz bar baz");
		// replaceAll は選択を動かさず選択の購読が反応しないので、rAF での数え直しを待つ
		await waitFor(() => expect(matchCount()).toHaveTextContent(/^No results$/));
	});

	// 押しても変わらないことは見ない。一致が無ければ replaceNext / replaceAll 自体が何もしない
	it("一致が無いと置換ボタンは無効になる", () => {
		renderBar(mountView("foo"), { initialExpanded: true, initialSearchText: "bar" });

		for (const name of ["置換", "すべて置換"]) {
			expect(screen.getByRole("button", { name })).toHaveAttribute("aria-disabled", "true");
		}
	});

	it("検索欄が空なら前後・置換のボタンを押しても何もしない", async () => {
		const view = mountView("foo");
		renderBar(view, { initialExpanded: true });

		for (const name of ["前の一致", "次の一致", "置換", "すべて置換"]) {
			await userEvent.click(screen.getByRole("button", { name }));
		}

		expect(view.state.doc.toString()).toBe("foo");
		expect(selected(view)).toEqual({ from: 0, to: 0 });
		expect(searchPanelOpen(view.state)).toBe(false);
	});

	it("一致があると置換ボタンは有効", () => {
		renderBar(mountView("foo"), { initialExpanded: true, initialSearchText: "foo" });

		for (const name of ["置換", "すべて置換"]) {
			expect(screen.getByRole("button", { name })).not.toHaveAttribute("aria-disabled");
		}
	});
});

describe("閉じる", () => {
	it("閉じるボタンで検索クエリを消して onClose を呼ぶ", async () => {
		const view = mountView("foo");
		const { onClose } = renderBar(view, { initialSearchText: "foo" });

		await userEvent.click(screen.getByRole("button", { name: "検索を閉じる" }));

		expect(getSearchQuery(view.state).search).toBe("");
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("検索欄の Esc で閉じる", async () => {
		const view = mountView("foo");
		const { onClose } = renderBar(view, { initialSearchText: "foo" });

		await userEvent.type(searchInput(), "{Escape}");

		expect(getSearchQuery(view.state).search).toBe("");
		expect(onClose).toHaveBeenCalled();
	});

	it("置換欄の Esc で閉じる", async () => {
		const view = mountView("foo");
		const { onClose } = renderBar(view, { initialExpanded: true, initialSearchText: "foo" });

		await userEvent.type(replaceInput(), "{Escape}");

		expect(getSearchQuery(view.state).search).toBe("");
		expect(onClose).toHaveBeenCalled();
	});

	it("入力欄の外（ボタン）にフォーカスがあっても Esc で閉じる", () => {
		const view = mountView("foo");
		const { onClose } = renderBar(view, { initialSearchText: "foo" });
		const button = screen.getByRole("button", { name: "次の一致" });
		act(() => {
			button.focus();
		});
		expect(button).toHaveFocus();

		fireEvent.keyDown(button, { key: "Escape" });

		expect(getSearchQuery(view.state).search).toBe("");
		expect(onClose).toHaveBeenCalledOnce();
	});
});

describe("置換欄の開閉", () => {
	it("最初は閉じていて、トグルで開くと置換欄にフォーカスする", async () => {
		renderBar(mountView("foo"));
		expect(screen.queryByRole("textbox", { name: "置換" })).toBeNull();

		const toggle = screen.getByRole("button", { name: "置換を開く" });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(toggle);

		expect(replaceInput()).toHaveFocus();
		expect(screen.getByRole("button", { name: "置換を閉じる" })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
	});

	it("開いた置換欄はトグルで閉じる", async () => {
		renderBar(mountView("foo"), { initialExpanded: true });

		await userEvent.click(screen.getByRole("button", { name: "置換を閉じる" }));

		expect(screen.queryByRole("textbox", { name: "置換" })).toBeNull();
		expect(screen.getByRole("button", { name: "置換を開く" })).toBeInTheDocument();
	});

	it("開いた状態で mount したときは検索欄にフォーカスする", () => {
		renderBar(mountView("foo"), { initialExpanded: true });

		expect(replaceInput()).toBeInTheDocument();
		expect(searchInput()).toHaveFocus();
	});

	it("開いた状態で mount しても、閉じて開き直すと置換欄にフォーカスする", async () => {
		renderBar(mountView("foo"), { initialExpanded: true });

		await userEvent.click(screen.getByRole("button", { name: "置換を閉じる" }));
		await userEvent.click(screen.getByRole("button", { name: "置換を開く" }));

		expect(replaceInput()).toHaveFocus();
	});

	it("置換文字列も CodeMirror の検索クエリに入る", async () => {
		const view = mountView("foo");
		renderBar(view, { initialExpanded: true, initialSearchText: "foo" });

		await userEvent.type(replaceInput(), "baz");

		expect(getSearchQuery(view.state).replace).toBe("baz");
	});
});

describe("mount", () => {
	it("検索欄にフォーカスし、初期テキストを全選択する", () => {
		const view = mountView("foo");
		renderBar(view, { initialSearchText: "foo" });

		const input = searchInput();
		expect(input).toHaveFocus();
		expect(input.value).toBe("foo");
		expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
		expect(getSearchQuery(view.state).search).toBe("foo");
	});
});

describe("view の state 差し替え（#220）", () => {
	it("viewEpoch が変わると、消えた検索クエリを入れ直して件数を数え直す", () => {
		const view = mountView("foo");
		const { rerender, onClose } = renderBar(view, { initialSearchText: "foo", viewEpoch: 0 });

		replaceState(view, "foo foo");
		expect(getSearchQuery(view.state).search).toBe("");

		rerender(<SearchBar view={view} onClose={onClose} initialSearchText="foo" viewEpoch={1} />);

		expect(getSearchQuery(view.state).search).toBe("foo");
		expect(matchCount()).toHaveTextContent(/^2 results$/);
	});

	it("viewEpoch が変わると、選択の購読をかけ直す", () => {
		const view = mountView("foo");
		const { rerender, onClose } = renderBar(view, { initialSearchText: "foo", viewEpoch: 0 });

		replaceState(view, "foo foo");
		rerender(<SearchBar view={view} onClose={onClose} initialSearchText="foo" viewEpoch={1} />);
		select(view, 4, 7);

		expect(matchCount()).toHaveTextContent(/^2 of 2$/);
	});

	it("アンマウントと viewEpoch の変更で、前の購読を外す", () => {
		const view = mountView("foo");
		const listeners = () => view.state.facet(EditorView.updateListener).length;
		const before = listeners();
		const { rerender, unmount, onClose } = renderBar(view, { viewEpoch: 0 });
		expect(listeners()).toBe(before + 1);

		rerender(<SearchBar view={view} onClose={onClose} viewEpoch={1} />);
		expect(listeners()).toBe(before + 1);

		unmount();
		expect(listeners()).toBe(before);
	});
});

describe("handleRef", () => {
	it("focusInput で検索欄にフォーカスし、テキストを全選択する", async () => {
		const handleRef = createRef<SearchBarHandle>();
		renderBar(mountView("foo"), { initialSearchText: "foo", handleRef });
		searchInput().setSelectionRange(3, 3);
		await userEvent.click(screen.getByRole("button", { name: "置換を開く" }));
		expect(searchInput()).not.toHaveFocus();

		act(() => {
			handleRef.current?.focusInput();
		});

		const input = searchInput();
		expect(input).toHaveFocus();
		expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
	});

	it("setSearch で検索文字列を差し替え、検索欄にフォーカスして全選択する", async () => {
		const view = mountView("foo bar bar");
		const handleRef = createRef<SearchBarHandle>();
		renderBar(view, { initialSearchText: "foo", handleRef });
		await userEvent.click(screen.getByRole("button", { name: "置換を開く" }));
		expect(searchInput()).not.toHaveFocus();

		act(() => {
			handleRef.current?.setSearch("bar");
		});

		expect(getSearchQuery(view.state).search).toBe("bar");
		expect(matchCount()).toHaveTextContent(/^2 results$/);
		await waitFor(() => expect(searchInput()).toHaveFocus());
		const input = searchInput();
		expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
	});
});
