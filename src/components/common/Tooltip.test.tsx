import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip";

describe("Tooltip", () => {
	it("hover で label と keys が表示され、trigger に aria-describedby が付く", async () => {
		render(
			<Tooltip label="サイドバー" keys={["⌘", "/"]}>
				<button type="button">トグル</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

		await userEvent.hover(trigger);

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

	it("unhover で消える", async () => {
		render(
			<Tooltip label="サイドバー" keys={["⌘", "/"]}>
				<button type="button">トグル</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });

		await userEvent.hover(trigger);
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		await userEvent.unhover(trigger);
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
		expect(trigger).not.toHaveAttribute("aria-describedby");
	});

	it("キーボードフォーカスで表示、blur で消える", async () => {
		render(
			<>
				<Tooltip label="サイドバー" keys={["⌘", "/"]}>
					<button type="button">トグル</button>
				</Tooltip>
				<button type="button">別ボタン</button>
			</>,
		);

		// tab で最初の button にフォーカス
		await userEvent.tab();
		expect(screen.getByRole("button", { name: "トグル" })).toHaveFocus();
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		// さらに tab で blur
		await userEvent.tab();
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("クリック（pointerdown）で消え、マウスクリック由来の focus では表示しない", async () => {
		render(
			<Tooltip label="サイドバー" keys={["⌘", "/"]}>
				<button type="button">トグル</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });

		// hover で一度表示してから click
		await userEvent.hover(trigger);
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		await userEvent.click(trigger);
		// pointerdown で消え、直後の focus でも再表示しない
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("Escape で消える", async () => {
		render(
			<Tooltip label="サイドバー" keys={["⌘", "/"]}>
				<button type="button">トグル</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "トグル" });

		await userEvent.hover(trigger);
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("keys 省略時は label のみ（kbd 要素なし）", async () => {
		render(
			<Tooltip label="手動同期">
				<button type="button">同期</button>
			</Tooltip>,
		);
		const trigger = screen.getByRole("button", { name: "同期" });

		await userEvent.hover(trigger);
		const tooltip = screen.getByRole("tooltip");
		expect(tooltip).toHaveTextContent("手動同期");
		expect(tooltip.querySelectorAll("kbd")).toHaveLength(0);
	});

	it("children 既存の onMouseEnter / onFocus ハンドラが合成されて呼ばれる", async () => {
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

		await userEvent.hover(trigger);
		expect(onMouseEnter).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("tooltip")).toBeInTheDocument();

		await userEvent.unhover(trigger);
		// キーボードフォーカスで既存 onFocus も呼ばれる
		await userEvent.tab();
		expect(onFocus).toHaveBeenCalled();
	});
});
