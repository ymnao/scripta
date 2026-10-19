import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWikilinkStore } from "../../../stores/wikilink";
import { useWorkspaceStore } from "../../../stores/workspace";
import type { UnresolvedWikilinkReference } from "../../../types/wikilink";
import { cleanupMountedViews, mountEditorView } from "./test-helper";
import { wikilinkHoverTooltip } from "./wikilink-hover";
import { buildDecorations, buildFileMap } from "./wikilinks";

const WORKSPACE = "/workspace";
const SHOW_DELAY = 300;
const CLOSE_DELAY = 150;

/** `[[page]]` を並べた文書を mount し、wikilinks.ts の装飾を付ける。wikilinkDecoration を
 *  そのまま載せないのは、fileMap を非同期の searchFilenames で取るまで装飾が出ないため */
function mountLinks(pages: string[], existing: string[] = []): EditorView {
	const doc = pages.map((page) => `[[${page}]]`).join(" ");
	const fileMap = buildFileMap(existing.map((page) => `${WORKSPACE}/${page}.md`));
	const decorations = EditorView.decorations.of((view) => buildDecorations(view, fileMap));
	return mountEditorView(doc, [decorations, wikilinkHoverTooltip]);
}

function mountMissing(): EditorView {
	return mountLinks(["missing-page"]);
}

function linkAt(view: EditorView, index = 0): HTMLElement {
	const el = view.dom.querySelectorAll<HTMLElement>(".cm-wikilink")[index];
	if (!el) throw new Error(`link ${index} not found`);
	return el;
}

function popups(): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>("[data-page-name]"));
}

function popup(): HTMLElement {
	const [el] = popups();
	if (!el) throw new Error("popup not shown");
	return el;
}

/** toEqual で比べないのは、作り直した同じ形のポップアップでも一致してしまうため */
function expectOnlyPopup(el: HTMLElement): void {
	expect(popups()).toHaveLength(1);
	expect(popups()[0]).toBe(el);
}

function textarea(): HTMLTextAreaElement {
	const el = popup().querySelector("textarea");
	if (!el) throw new Error("textarea not found");
	return el;
}

function createButton(): HTMLButtonElement {
	const el = popup().querySelector("button");
	if (!el) throw new Error("create button not found");
	return el;
}

function hover(el: Element): void {
	el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}

function leave(el: Element, relatedTarget: Element | null = null): void {
	el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget }));
}

function hoverAndWait(view: EditorView, index = 0): void {
	hover(linkAt(view, index));
	vi.advanceTimersByTime(SHOW_DELAY);
}

function showPopup(view: EditorView, index = 0): HTMLElement {
	hoverAndWait(view, index);
	return popup();
}

function ref(filePath: string, lineNumber: number): UnresolvedWikilinkReference {
	return {
		filePath,
		lineNumber,
		byteOffset: 0,
		lineContent: "",
		contextBefore: [],
		contextAfter: [],
		displayPath: filePath,
	};
}

function placeLink(el: HTMLElement, rect: { top: number; bottom: number; left: number }): void {
	vi.spyOn(el, "getBoundingClientRect").mockReturnValue(
		new DOMRect(rect.left, rect.top, 40, rect.bottom - rect.top),
	);
}

describe("未解決リンクのホバーポップアップ", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useWorkspaceStore.setState({ workspacePath: WORKSPACE });
		useWikilinkStore.getState().reset();
	});

	afterEach(() => {
		cleanupMountedViews();
		for (const el of popups()) el.remove();
		useWikilinkStore.getState().reset();
		useWorkspaceStore.setState({ workspacePath: null });
	});

	describe("表示", () => {
		it("未解決リンクに乗せて 300ms 経つと、ページ名のポップアップが出る", () => {
			const view = mountMissing();
			hover(linkAt(view));
			vi.advanceTimersByTime(SHOW_DELAY - 1);
			expect(popups()).toHaveLength(0);
			vi.advanceTimersByTime(1);
			expect(popups()).toHaveLength(1);
			expect(popup().dataset.pageName).toBe("missing-page");
			expect(popup().textContent).toContain("missing-page");
		});

		it("解決済みのリンクでは出ない", () => {
			const view = mountLinks(["exists"], ["exists"]);
			hoverAndWait(view);
			expect(popups()).toHaveLength(0);
		});

		it("300ms より前にリンクから離れると出ない", () => {
			const view = mountMissing();
			hover(linkAt(view));
			// 表示予定の 150ms より前に離れる。後に離れると、表示の取り消しが効かなくても
			// 表示のあとに閉じる処理が走り、結果が同じになる
			vi.advanceTimersByTime(SHOW_DELAY - CLOSE_DELAY - 1);
			leave(linkAt(view));
			vi.advanceTimersByTime(SHOW_DELAY);
			expect(popups()).toHaveLength(0);
		});

		it("表示中に同じリンクへ乗り直しても、ポップアップを作り直さない", () => {
			const view = mountMissing();
			const first = showPopup(view);
			hoverAndWait(view);
			expectOnlyPopup(first);
		});

		it("表示中に別の未解決リンクへ移ると、そのリンクのポップアップに置き換わる", () => {
			const view = mountLinks(["first", "second"]);
			showPopup(view, 0);
			hoverAndWait(view, 1);
			expect(popups().map((el) => el.dataset.pageName)).toEqual(["second"]);
		});
	});

	describe("位置", () => {
		it("リンクの 4px 下に、左端をそろえて出す", () => {
			const view = mountMissing();
			placeLink(linkAt(view), { top: 100, bottom: 120, left: 50 });
			showPopup(view);
			expect(popup().style.top).toBe("124px");
			expect(popup().style.left).toBe("50px");
			expect(popup().style.transform).toBe("");
		});

		it("出す位置から下にちょうど 200px あるときは、下に出す", () => {
			const view = mountMissing();
			const bottom = window.innerHeight - 204;
			placeLink(linkAt(view), { top: bottom - 20, bottom, left: 50 });
			showPopup(view);
			expect(popup().style.top).toBe(`${bottom + 4}px`);
			expect(popup().style.transform).toBe("");
		});

		it("出す位置から下に 200px 無いときは、リンクの 4px 上に出す", () => {
			const view = mountMissing();
			const bottom = window.innerHeight - 203;
			placeLink(linkAt(view), { top: bottom - 20, bottom, left: 50 });
			showPopup(view);
			expect(popup().style.top).toBe(`${bottom - 24}px`);
			expect(popup().style.transform).toBe("translateY(-100%)");
		});

		it("右端からはみ出す位置では、ウィンドウの右端から 268px 内側に寄せる", () => {
			const view = mountMissing();
			placeLink(linkAt(view), { top: 100, bottom: 120, left: window.innerWidth - 10 });
			showPopup(view);
			expect(popup().style.left).toBe(`${window.innerWidth - 268}px`);
		});

		it("左端からはみ出す位置では、左端から 4px に寄せる", () => {
			const view = mountMissing();
			placeLink(linkAt(view), { top: 100, bottom: 120, left: -30 });
			showPopup(view);
			expect(popup().style.left).toBe("4px");
		});
	});

	describe("閉じる", () => {
		it("リンクから離れて 150ms 経つと閉じる", () => {
			const view = mountMissing();
			showPopup(view);
			leave(linkAt(view));
			vi.advanceTimersByTime(CLOSE_DELAY - 1);
			expect(popups()).toHaveLength(1);
			vi.advanceTimersByTime(1);
			expect(popups()).toHaveLength(0);
		});

		it("リンクからポップアップへ移ったときは閉じない", () => {
			const view = mountMissing();
			const el = showPopup(view);
			leave(linkAt(view), el);
			vi.advanceTimersByTime(CLOSE_DELAY);
			expectOnlyPopup(el);
		});

		it("閉じる前にポップアップへ入ると閉じない", () => {
			const view = mountMissing();
			const el = showPopup(view);
			leave(linkAt(view));
			el.dispatchEvent(new MouseEvent("mouseenter"));
			vi.advanceTimersByTime(CLOSE_DELAY);
			expectOnlyPopup(el);
		});

		it("閉じる前にリンクへ戻ると閉じない", () => {
			const view = mountMissing();
			const el = showPopup(view);
			leave(linkAt(view));
			hover(linkAt(view));
			vi.advanceTimersByTime(SHOW_DELAY + CLOSE_DELAY);
			expectOnlyPopup(el);
		});

		it("ポップアップから出て 150ms 経つと閉じる", () => {
			const view = mountMissing();
			const el = showPopup(view);
			el.dispatchEvent(new MouseEvent("mouseleave"));
			vi.advanceTimersByTime(CLOSE_DELAY);
			expect(popups()).toHaveLength(0);
		});

		it("ドラフト欄にフォーカスがある間は、リンクやポップアップから出ても閉じない", () => {
			const view = mountMissing();
			const el = showPopup(view);
			textarea().focus();
			leave(linkAt(view));
			vi.advanceTimersByTime(CLOSE_DELAY);
			el.dispatchEvent(new MouseEvent("mouseleave"));
			vi.advanceTimersByTime(CLOSE_DELAY);
			expectOnlyPopup(el);
		});

		it("ドラフト欄からフォーカスが外れて 150ms 経つと閉じる", () => {
			const view = mountMissing();
			showPopup(view);
			textarea().focus();
			textarea().blur();
			vi.advanceTimersByTime(CLOSE_DELAY);
			expect(popups()).toHaveLength(0);
		});
	});

	describe("内容", () => {
		it("参照があるときは件数を出す", () => {
			useWikilinkStore.setState({
				unresolvedLinks: [
					{
						pageName: "missing-page",
						references: [ref("/workspace/a.md", 1), ref("/workspace/b.md", 2)],
					},
				],
			});
			const view = mountMissing();
			showPopup(view);
			expect(popup().textContent).toContain("2 件の参照");
		});

		it("参照が無いときは件数を出さない", () => {
			const view = mountMissing();
			showPopup(view);
			expect(popup().textContent).not.toContain("件の参照");
		});

		it("保存済みのドラフトをドラフト欄に出す", () => {
			useWikilinkStore.getState().setDraft("missing-page", "saved");
			const view = mountMissing();
			showPopup(view);
			expect(textarea().value).toBe("saved");
		});

		it("ドラフト欄に入力すると、そのページのドラフトとして保存する", () => {
			const view = mountMissing();
			showPopup(view);
			textarea().value = "edited";
			textarea().dispatchEvent(new Event("input"));
			expect(useWikilinkStore.getState().getDraft("missing-page")).toBe("edited");
		});

		it("表示中に未解決リンクの一覧が更新されると、件数を描き直す", () => {
			const view = mountMissing();
			showPopup(view);
			useWikilinkStore.setState({
				unresolvedLinks: [{ pageName: "missing-page", references: [ref("/workspace/a.md", 1)] }],
			});
			expect(popup().textContent).toContain("1 件の参照");
		});

		it("一覧の更新で描き直しても、ドラフト欄の入力は残る", () => {
			const view = mountMissing();
			showPopup(view);
			const before = textarea();
			// input を流さずに値だけ変え、描き直しの直前に textarea から拾うことを見る
			before.value = "typing";
			useWikilinkStore.setState({
				unresolvedLinks: [{ pageName: "missing-page", references: [ref("/workspace/a.md", 1)] }],
			});
			expect(textarea()).not.toBe(before);
			expect(textarea().value).toBe("typing");
		});

		it("「ファイルを作成」を押すと、そのページと参照を作成先の選択に渡す", () => {
			const references = [ref("/workspace/a.md", 3)];
			useWikilinkStore.setState({
				unresolvedLinks: [{ pageName: "missing-page", references }],
			});
			const view = mountMissing();
			showPopup(view);
			createButton().dispatchEvent(new MouseEvent("click"));
			expect(useWikilinkStore.getState().createTarget).toEqual({
				pageName: "missing-page",
				references,
			});
		});

		it("「ファイルを作成」を押すと閉じる", () => {
			const view = mountMissing();
			showPopup(view);
			createButton().dispatchEvent(new MouseEvent("click"));
			expect(popups()).toHaveLength(0);
		});
	});

	describe("後始末", () => {
		it("閉じたポップアップのページへ、次に開いた別ページのドラフトを書き込まない", () => {
			const view = mountLinks(["first", "second"]);
			showPopup(view, 0);
			leave(linkAt(view, 0));
			vi.advanceTimersByTime(CLOSE_DELAY);
			showPopup(view, 1);
			textarea().value = "typing";
			useWikilinkStore.setState({ unresolvedLinks: [] });
			expect(useWikilinkStore.getState().getDraft("first")).toBe("");
			expect(useWikilinkStore.getState().getDraft("second")).toBe("typing");
		});

		it("view を破棄すると、表示中のポップアップが消える", () => {
			const view = mountMissing();
			showPopup(view);
			view.destroy();
			expect(popups()).toHaveLength(0);
		});

		it("view を破棄すると、表示待ちのポップアップも出ない", () => {
			const view = mountMissing();
			hover(linkAt(view));
			view.destroy();
			vi.advanceTimersByTime(SHOW_DELAY);
			expect(popups()).toHaveLength(0);
		});

		it("view を破棄したあとは、リンクに乗せても出ない", () => {
			const view = mountMissing();
			const link = linkAt(view);
			view.destroy();
			hover(link);
			vi.advanceTimersByTime(SHOW_DELAY);
			expect(popups()).toHaveLength(0);
		});
	});
});
