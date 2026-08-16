import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SearchResult } from "../../types/search";

vi.mock("../../lib/commands", () => ({
	searchFiles: vi.fn(),
	cancelSearch: vi.fn().mockResolvedValue(undefined),
}));

// 実値 500 のまま描画すると 1 テストあたり 500-700 行の実描画で 1s 級になり、
// フルスイートの CPU 競合下で testTimeout に届く (#501)。段階表示の性質は
// step に対して parametric なので、小さい値を注入して同じ性質を pin する。
// 以降の期待値を MATCH_DISPLAY_STEP 変数ではなく literal で書くのは、注入が
// 効かなくなったとき変数側も 500 に追随して「500 行描画のまま pass」してしまい、
// 再発が観測に出ないため。
vi.mock("../../types/search", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../types/search")>();
	return { ...actual, MATCH_DISPLAY_STEP: 5 };
});

const { searchFiles } = await import("../../lib/commands");
const { SearchPanel, sliceGroupedResults } = await import("./SearchPanel");

const mockedSearchFiles = searchFiles as Mock;

const WORKSPACE = "/workspace";

function group(filePath: string, count: number) {
	return {
		filePath,
		relativePath: filePath.slice(WORKSPACE.length + 1),
		matches: Array.from({ length: count }, (_, i) => ({
			filePath,
			lineNumber: i + 1,
			lineContent: "match",
			matchStart: 0,
			matchEnd: 5,
		})),
	};
}

function results(filePath: string, count: number): SearchResult[] {
	return group(filePath, count).matches;
}

describe("sliceGroupedResults", () => {
	it("limit が group 境界をまたぐと最後の group だけ部分 slice される", () => {
		const visible = sliceGroupedResults(
			[group("/workspace/a.md", 3), group("/workspace/b.md", 4), group("/workspace/c.md", 5)],
			5,
		);

		expect(visible.map((g) => g.filePath)).toEqual(["/workspace/a.md", "/workspace/b.md"]);
		expect(visible[1].matches).toHaveLength(2);
	});

	it("limit が group 境界とちょうど一致すると次の group は含まれない", () => {
		const visible = sliceGroupedResults(
			[group("/workspace/a.md", 3), group("/workspace/b.md", 4)],
			3,
		);

		expect(visible.map((g) => g.filePath)).toEqual(["/workspace/a.md"]);
		expect(visible[0].matches).toHaveLength(3);
	});

	it("limit が総 match 数以上なら全件が visible になる", () => {
		const groups = [group("/workspace/a.md", 3), group("/workspace/b.md", 4)];

		expect(sliceGroupedResults(groups, 7)).toHaveLength(2);
		expect(sliceGroupedResults(groups, 8)).toHaveLength(2);
		expect(sliceGroupedResults(groups, 8)[1].matches).toHaveLength(4);
	});

	it("元の group の matches を破壊しない", () => {
		const groups = [group("/workspace/a.md", 4)];

		sliceGroupedResults(groups, 2);

		expect(groups[0].matches).toHaveLength(4);
	});

	it("空の結果では visible も空になる", () => {
		expect(sliceGroupedResults([], 5)).toEqual([]);
	});
});

describe("段階表示の 1 単位", () => {
	it("production の実値は 500", async () => {
		const actual = await vi.importActual<typeof import("../../types/search")>("../../types/search");

		expect(actual.MATCH_DISPLAY_STEP).toBe(500);
	});
});

describe("SearchPanel の段階表示", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
	});

	function renderPanel() {
		return render(<SearchPanel workspacePath={WORKSPACE} onNavigate={vi.fn()} />);
	}

	async function search(query: string): Promise<void> {
		fireEvent.change(screen.getByRole("textbox", { name: "ワークスペース内を検索" }), {
			target: { value: query },
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(300);
		});
	}

	it("初回描画は 1 単位までで、残件数がボタンに出る", async () => {
		mockedSearchFiles.mockResolvedValue({
			results: results("/workspace/big.md", 7),
			truncated: false,
		});
		renderPanel();

		await search("match");

		expect(document.querySelectorAll(".search-panel-match")).toHaveLength(5);
		expect(screen.getByRole("button", { name: "さらに表示 (残り 2 件)" })).toBeTruthy();
	});

	it("件数表示と打ち切り notice は初回分と同時に見えている", async () => {
		mockedSearchFiles.mockResolvedValue({
			results: results("/workspace/big.md", 6),
			truncated: true,
		});
		renderPanel();

		await search("match");

		expect(screen.getByText("1 ファイル中 6 件")).toBeTruthy();
		expect(screen.getByText("結果が多すぎるため 10,000 件で打ち切りました")).toBeTruthy();
		expect(document.querySelectorAll(".search-panel-match")).toHaveLength(5);
	});

	it("「さらに表示」を押すと描画数が増え、全件出るとボタンが消える", async () => {
		mockedSearchFiles.mockResolvedValue({
			results: results("/workspace/big.md", 7),
			truncated: false,
		});
		renderPanel();

		await search("match");
		expect(document.querySelectorAll(".search-panel-match")).toHaveLength(5);

		fireEvent.click(screen.getByRole("button", { name: "さらに表示 (残り 2 件)" }));

		expect(document.querySelectorAll(".search-panel-match")).toHaveLength(7);
		expect(screen.queryByRole("button", { name: /さらに表示/ })).toBeNull();
	});

	it("新しい検索の結果では表示件数が初期値に戻る", async () => {
		mockedSearchFiles.mockResolvedValue({
			results: results("/workspace/big.md", 15),
			truncated: false,
		});
		renderPanel();

		await search("match");
		expect(document.querySelectorAll(".search-panel-match")).toHaveLength(5);
		fireEvent.click(screen.getByRole("button", { name: /さらに表示/ }));
		expect(document.querySelectorAll(".search-panel-match")).toHaveLength(10);

		mockedSearchFiles.mockResolvedValue({
			results: results("/workspace/other.md", 7),
			truncated: false,
		});
		await search("other");

		expect(screen.getByText("1 ファイル中 7 件")).toBeTruthy();
		expect(document.querySelectorAll(".search-panel-match")).toHaveLength(5);
	});
});
