import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLTIP_SHOW_DELAY_MS, Tooltip } from "./Tooltip";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// NOTE: 当初の仕様では userEvent.setup({ advanceTimers }) を使う想定だったが、本リポジトリの
// 実行環境（vitest 4 + jsdom + @testing-library/user-event）では vi.useFakeTimers() 下で
// userEvent.hover / tab の await が解決せずデッドロックする（advanceTimers / delay:null でも回避不可。
// 素の <button> でも再現）。500ms 表示遅延を fake timers で検証する都合上、interaction は
// fireEvent（同期・fake timers と両立）で発火する。pointer / focus / blur / keydown いずれも
// component のハンドラを直接叩くため、各テストの意図（warm-up / skip delay / keyboard 即時表示）は
// そのまま担保される。

/** 表示遅延ぶんタイマーを進める（setState を act で包む）。 */
function advanceShowDelay() {
	act(() => {
		vi.advanceTimersByTime(TOOLTIP_SHOW_DELAY_MS);
	});
}

/** クリック相当（pointerdown → focus）を発火する。pointer 由来 focus 抑制ロジックを通す。 */
function clickLikePointer(el: HTMLElement) {
	fireEvent.pointerDown(el);
	fireEvent.focus(el);
}

describe("Tooltip", () => {
	it("hover → 500ms 経過で label と keys が表示され、trigger に aria-describedby が付く", () => {
		render(
			<Tooltip label="サイドバー" keys={["⌘", "/"]}>
				<button type="button">トグル</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

		fireEvent.mouseEnter(trigger);
		advanceShowDelay();

		const tooltip = screen.getByRole("tooltip");
		expect(tooltip).toHaveTextContent("サイドバー");
		// keys は Kbd（kbd 要素）として描画される
		const kbds = tooltip.querySelectorAll("kbd");
		expect(kbds).toHaveLength(2);
		expect(kbds[0]).toHaveTextContent("⌘");
		expect(kbds[1]).toHaveTextContent("/");
		// 表示中は aria-describedby が tooltip の id を指す
		expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);
	});

	it("hover 直後（499ms）はまだ表示されず、500ms 到達で表示される", () => {
		render(
			<Tooltip label="サイドバー" keys={["⌘", "/"]}>
				<button type="button">トグル</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });

		fireEvent.mouseEnter(trigger);
		act(() => {
			vi.advanceTimersByTime(TOOLTIP_SHOW_DELAY_MS - 1);
		});
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(1);
		});
		expect(screen.getByRole("tooltip")).toBeInTheDocument();
	});

	it("遅延中に unhover するとキャンセルされ、その後 500ms 進めても表示されない", () => {
		render(
			<Tooltip label="サイドバー" keys={["⌘", "/"]}>
				<button type="button">トグル</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });

		fireEvent.mouseEnter(trigger);
		act(() => {
			vi.advanceTimersByTime(200);
		});
		fireEvent.mouseLeave(trigger);
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

		advanceShowDelay();
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("unhover で消える", () => {
		render(
			<Tooltip label="サイドバー" keys={["⌘", "/"]}>
				<button type="button">トグル</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });

		fireEvent.mouseEnter(trigger);
		advanceShowDelay();
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		fireEvent.mouseLeave(trigger);
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
		expect(trigger).not.toHaveAttribute("aria-describedby");
	});

	it("表示中の tooltip から別 trigger へすぐ移っても、次の tooltip は改めて 500ms 待つ", () => {
		render(
			<>
				<Tooltip label="ボタン A">
					<button type="button">A</button>
				</Tooltip>
				<Tooltip label="ボタン B">
					<button type="button">B</button>
				</Tooltip>
			</>,
		);
		const a = screen.getByRole("button", { name: "A" });
		const b = screen.getByRole("button", { name: "B" });

		fireEvent.mouseEnter(a);
		advanceShowDelay();
		expect(screen.getByRole("tooltip")).toHaveTextContent("ボタン A");

		// A 表示中にすぐ B へ移る — 即時表示はされない
		fireEvent.mouseLeave(a);
		fireEvent.mouseEnter(b);
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

		advanceShowDelay();
		expect(screen.getByRole("tooltip")).toHaveTextContent("ボタン B");
	});

	it("キーボードフォーカスはタイマーを進めずに即表示、blur で消える", () => {
		render(
			<Tooltip label="サイドバー" keys={["⌘", "/"]}>
				<button type="button">トグル</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });

		// keyboard focus（先行する pointerdown なし）→ 遅延なしで即表示
		fireEvent.focus(trigger);
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		fireEvent.blur(trigger);
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("クリック（pointerdown）で消え、マウスクリック由来の focus では表示しない", () => {
		render(
			<Tooltip label="サイドバー" keys={["⌘", "/"]}>
				<button type="button">トグル</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });

		// hover で一度表示してから click
		fireEvent.mouseEnter(trigger);
		advanceShowDelay();
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		clickLikePointer(trigger);
		// pointerdown で消え、直後の focus でも再表示しない
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("focus 済みのまま再クリックしても、blur 後の次のキーボードフォーカスで表示される", () => {
		render(
			<Tooltip label="サイドバー">
				<button type="button">トグル</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });

		// keyboard focus で表示
		fireEvent.focus(trigger);
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		// focus 済みボタンの再クリック: pointerdown は発火するが focus イベントは発生しない
		// （pointer 由来フラグが消費されず残るシナリオ）
		fireEvent.pointerDown(trigger);
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

		// blur でフラグが清算され、次の keyboard focus は抑制されず表示される
		fireEvent.blur(trigger);
		fireEvent.focus(trigger);
		expect(screen.getByRole("tooltip")).toBeInTheDocument();
	});

	it("Escape で消える", () => {
		render(
			<Tooltip label="サイドバー" keys={["⌘", "/"]}>
				<button type="button">トグル</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });

		fireEvent.mouseEnter(trigger);
		advanceShowDelay();
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("keys 省略時は label のみ（kbd 要素なし）", () => {
		render(
			<Tooltip label="手動同期">
				<button type="button">同期</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "同期" });

		fireEvent.mouseEnter(trigger);
		advanceShowDelay();
		const tooltip = screen.getByRole("tooltip");
		expect(tooltip).toHaveTextContent("手動同期");
		expect(tooltip.querySelectorAll("kbd")).toHaveLength(0);
	});

	it("children 既存の onMouseEnter / onFocus ハンドラが合成されて呼ばれる", () => {
		const onMouseEnter = vi.fn();
		const onFocus = vi.fn();
		render(
			<Tooltip label="サイドバー" keys={["⌘", "/"]}>
				<button type="button" onMouseEnter={onMouseEnter} onFocus={onFocus}>
					トグル
				</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });

		fireEvent.mouseEnter(trigger);
		advanceShowDelay();
		expect(onMouseEnter).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		fireEvent.mouseLeave(trigger);
		// キーボードフォーカスで既存 onFocus も呼ばれる
		fireEvent.focus(trigger);
		expect(onFocus).toHaveBeenCalled();
	});
});
