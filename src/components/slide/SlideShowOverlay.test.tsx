import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { parseSlides } from "../../lib/slide-parser";
import { SlideShowOverlay } from "./SlideShowOverlay";

const MULTI = parseSlides("# One\n\n---\n\n# Two\n\n---\n\n# Three");
const EMPTY = parseSlides("");

describe("SlideShowOverlay", () => {
	it("startIndex のスライドを初期表示する", () => {
		render(<SlideShowOverlay slides={MULTI} startIndex={1} onClose={() => {}} />);
		expect(screen.getByText("Two")).toBeDefined();
		expect(screen.getByText("2 / 3")).toBeDefined();
	});

	it("ArrowRight で次、ArrowLeft で前に進む", async () => {
		const user = userEvent.setup();
		render(<SlideShowOverlay slides={MULTI} startIndex={0} onClose={() => {}} />);
		expect(screen.getByText("One")).toBeDefined();
		await user.keyboard("{ArrowRight}");
		expect(screen.getByText("Two")).toBeDefined();
		await user.keyboard("{ArrowRight}");
		expect(screen.getByText("Three")).toBeDefined();
		// 末尾でこれ以上進まない
		await user.keyboard("{ArrowRight}");
		expect(screen.getByText("Three")).toBeDefined();
		await user.keyboard("{ArrowLeft}");
		expect(screen.getByText("Two")).toBeDefined();
	});

	it("Space / PageDown / j でも次に進む", async () => {
		const user = userEvent.setup();
		render(<SlideShowOverlay slides={MULTI} startIndex={0} onClose={() => {}} />);
		await user.keyboard(" ");
		expect(screen.getByText("Two")).toBeDefined();
		await user.keyboard("{PageDown}");
		expect(screen.getByText("Three")).toBeDefined();
	});

	it("j でも次に進む", async () => {
		const user = userEvent.setup();
		render(<SlideShowOverlay slides={MULTI} startIndex={0} onClose={() => {}} />);
		await user.keyboard("j");
		expect(screen.getByText("Two")).toBeDefined();
	});

	it("PageUp / Backspace でも前に戻る", async () => {
		const user = userEvent.setup();
		render(<SlideShowOverlay slides={MULTI} startIndex={2} onClose={() => {}} />);
		await user.keyboard("{PageUp}");
		expect(screen.getByText("Two")).toBeDefined();
		await user.keyboard("{Backspace}");
		expect(screen.getByText("One")).toBeDefined();
	});

	it("k でも前に戻る", async () => {
		const user = userEvent.setup();
		render(<SlideShowOverlay slides={MULTI} startIndex={2} onClose={() => {}} />);
		await user.keyboard("k");
		expect(screen.getByText("Two")).toBeDefined();
	});

	it("先頭で ArrowLeft を押しても index=0 のまま", async () => {
		const user = userEvent.setup();
		render(<SlideShowOverlay slides={MULTI} startIndex={0} onClose={() => {}} />);
		await user.keyboard("{ArrowLeft}");
		await user.keyboard("{PageUp}");
		await user.keyboard("{Backspace}");
		await user.keyboard("k");
		expect(screen.getByText("1 / 3")).toBeDefined();
	});

	it("Cmd/Ctrl 修飾付き n/j/p/k は無視される (他ショートカットと衝突しない)", () => {
		const onClose = vi.fn();
		render(<SlideShowOverlay slides={MULTI} startIndex={1} onClose={onClose} />);
		fireEvent.keyDown(document, { key: "n", ctrlKey: true });
		fireEvent.keyDown(document, { key: "j", metaKey: true });
		expect(screen.getByText("Two")).toBeDefined();
	});

	it("負数 startIndex は先頭にクランプする", () => {
		render(<SlideShowOverlay slides={MULTI} startIndex={-5} onClose={() => {}} />);
		expect(screen.getByText("1 / 3")).toBeDefined();
	});

	it("Home / End で先頭・末尾へジャンプする", async () => {
		const user = userEvent.setup();
		render(<SlideShowOverlay slides={MULTI} startIndex={1} onClose={() => {}} />);
		await user.keyboard("{End}");
		expect(screen.getByText("3 / 3")).toBeDefined();
		await user.keyboard("{Home}");
		expect(screen.getByText("1 / 3")).toBeDefined();
	});

	it("Esc で onClose が呼ばれる", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		render(<SlideShowOverlay slides={MULTI} startIndex={0} onClose={onClose} />);
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("終了ボタンで onClose が呼ばれる", async () => {
		const user = userEvent.setup();
		const onClose = vi.fn();
		render(<SlideShowOverlay slides={MULTI} startIndex={0} onClose={onClose} />);
		await user.click(screen.getByRole("button", { name: /発表モードを終了/ }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("startIndex が範囲外なら最後のスライドにクランプする", () => {
		render(<SlideShowOverlay slides={MULTI} startIndex={99} onClose={() => {}} />);
		expect(screen.getByText("3 / 3")).toBeDefined();
	});

	it("フォーカス要素から発生した keydown が document の bubble listener に届かない (AppLayout 競合防止)", () => {
		const bubbled = vi.fn();
		document.addEventListener("keydown", bubbled);
		try {
			render(<SlideShowOverlay slides={MULTI} startIndex={0} onClose={() => {}} />);
			// overlay 内の終了ボタン (実 DOM 子要素) を event target にして、実際の
			// キーイベント伝播経路 (target → capture-phase document listener → bubble
			// → document 別 listener) を再現する。capture-phase で stopPropagation
			// されれば bubble 側は呼ばれない。
			const btn = screen.getByRole("button", { name: /発表モードを終了/ });
			fireEvent.keyDown(btn, { key: "ArrowRight" });
			expect(bubbled).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener("keydown", bubbled);
		}
	});

	it("IME 合成中 (isComposing) の Escape は onClose を呼ばない", () => {
		const onClose = vi.fn();
		render(<SlideShowOverlay slides={MULTI} startIndex={0} onClose={onClose} />);
		fireEvent.keyDown(document, { key: "Escape", isComposing: true });
		expect(onClose).not.toHaveBeenCalled();
	});

	it("未対応キーでは index が変わらず onClose も呼ばれない", () => {
		const onClose = vi.fn();
		render(<SlideShowOverlay slides={MULTI} startIndex={1} onClose={onClose} />);
		fireEvent.keyDown(document, { key: "a" });
		fireEvent.keyDown(document, { key: "Tab" });
		fireEvent.keyDown(document, { key: "Enter" });
		expect(screen.getByText("2 / 3")).toBeDefined();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("CapsLock/Shift 時の 'N'/'P' でもナビゲーションが効く", async () => {
		const user = userEvent.setup();
		render(<SlideShowOverlay slides={MULTI} startIndex={0} onClose={() => {}} />);
		await user.keyboard("{Shift>}N{/Shift}");
		expect(screen.getByText("Two")).toBeDefined();
		await user.keyboard("{Shift>}P{/Shift}");
		expect(screen.getByText("One")).toBeDefined();
	});

	it("slides=[] でも `1 / 1` の空スライドにフォールバックする (runtime guard)", () => {
		render(<SlideShowOverlay slides={[]} startIndex={0} onClose={() => {}} />);
		expect(screen.getByText("1 / 1")).toBeDefined();
		expect(screen.getByText("空のスライド")).toBeDefined();
	});

	it("空マークダウンでも表示が壊れない", () => {
		render(<SlideShowOverlay slides={EMPTY} startIndex={0} onClose={() => {}} />);
		expect(screen.getByText("空のスライド")).toBeDefined();
		expect(screen.getByText("1 / 1")).toBeDefined();
	});
});
