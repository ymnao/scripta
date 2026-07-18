import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/commands", () => ({
	listDirectory: vi.fn().mockResolvedValue([]),
	searchFilenames: vi.fn(),
}));

vi.mock("../../lib/scripta-config", () => ({
	getScratchpadArchiveDir: vi.fn().mockReturnValue("/w/.scratchpad/archive"),
}));

const { searchFilenames } = await import("../../lib/commands");
const { CommandPalette } = await import("./CommandPalette");

describe("CommandPalette (useScrollActiveChildIntoView 統合)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(searchFilenames as ReturnType<typeof vi.fn>).mockResolvedValue([
			"/w/a.md",
			"/w/b.md",
			"/w/c.md",
			"/w/d.md",
		]);
	});

	it("ArrowDown で selectedIndex が変わると listbox.scrollBy が呼ばれる (hook 統合)", async () => {
		render(<CommandPalette open workspacePath="/w" onSelect={vi.fn()} onClose={vi.fn()} />);
		// 検索結果の option が描画されるまで待つ
		await waitFor(() => {
			expect(screen.getAllByRole("option")).toHaveLength(4);
		});
		const listbox = screen.getByRole("listbox");
		listbox.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
		// 各 option を 40px 高で 0-based に配置 → index=3 は [120, 160] で bottom overflow
		screen.getAllByRole("option").forEach((opt, i) => {
			opt.getBoundingClientRect = () => new DOMRect(0, i * 40, 200, 40);
		});
		const scrollBy = vi.fn();
		(listbox as unknown as { scrollBy: (arg: ScrollToOptions) => void }).scrollBy = scrollBy;

		// selectedIndex は初期 0。ArrowDown を 3 回押して 3 まで進める。
		const dialog = screen.getByRole("dialog");
		await act(async () => {
			fireEvent.keyDown(dialog, { key: "ArrowDown" });
			fireEvent.keyDown(dialog, { key: "ArrowDown" });
			fireEvent.keyDown(dialog, { key: "ArrowDown" });
		});

		// index=3 の option が [120, 160]、listbox [0, 100] → bottom はみ出し delta=60
		expect(scrollBy).toHaveBeenCalledWith({ top: 60, behavior: "auto" });
	});
});
