import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SearchResult } from "../../types/search";

vi.mock("../../lib/commands", () => ({
	searchFiles: vi.fn(),
	cancelSearch: vi.fn().mockResolvedValue(undefined),
}));

const { searchFiles } = await import("../../lib/commands");
const { MATCH_DISPLAY_STEP, SearchPanel, sliceGroupedResults } = await import("./SearchPanel");

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
		expect(sliceGroupedResults([], MATCH_DISPLAY_STEP)).toEqual([]);
	});
});

describe("SearchPanel の段階表示", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function renderPanel() {
		return render(<SearchPanel workspacePath={WORKSPACE} onNavigate={vi.fn()} />);
	}

	function search(query: string): void {
		fireEvent.change(screen.getByRole("textbox", { name: "ワークスペース内を検索" }), {
			target: { value: query },
		});
	}

	it("初回描画は MATCH_DISPLAY_STEP 件までで、残件数がボタンに出る", async () => {
		mockedSearchFiles.mockResolvedValue({
			results: results("/workspace/big.md", MATCH_DISPLAY_STEP + 200),
			truncated: false,
		});
		renderPanel();

		search("match");

		await waitFor(() => {
			expect(document.querySelectorAll(".search-panel-match")).toHaveLength(MATCH_DISPLAY_STEP);
		});
		expect(screen.getByRole("button", { name: "さらに表示 (残り 200 件)" })).toBeTruthy();
	});

	it("件数表示と打ち切り notice は先頭 500 件と同時に見えている", async () => {
		mockedSearchFiles.mockResolvedValue({
			results: results("/workspace/big.md", 10_000),
			truncated: true,
		});
		renderPanel();

		search("match");

		await waitFor(() => {
			expect(screen.getByText("1 ファイル中 10000 件")).toBeTruthy();
		});
		expect(screen.getByText("結果が多すぎるため 10,000 件で打ち切りました")).toBeTruthy();
		expect(document.querySelectorAll(".search-panel-match")).toHaveLength(MATCH_DISPLAY_STEP);
	});

	it("「さらに表示」を押すと描画数が増え、全件出るとボタンが消える", async () => {
		mockedSearchFiles.mockResolvedValue({
			results: results("/workspace/big.md", MATCH_DISPLAY_STEP + 200),
			truncated: false,
		});
		renderPanel();

		search("match");
		await waitFor(() => {
			expect(document.querySelectorAll(".search-panel-match")).toHaveLength(MATCH_DISPLAY_STEP);
		});

		fireEvent.click(screen.getByRole("button", { name: "さらに表示 (残り 200 件)" }));

		expect(document.querySelectorAll(".search-panel-match")).toHaveLength(MATCH_DISPLAY_STEP + 200);
		expect(screen.queryByRole("button", { name: /さらに表示/ })).toBeNull();
	});

	it("新しい検索の結果では表示件数が初期値に戻る", async () => {
		mockedSearchFiles.mockResolvedValue({
			results: results("/workspace/big.md", MATCH_DISPLAY_STEP * 3),
			truncated: false,
		});
		renderPanel();

		search("match");
		await waitFor(() => {
			expect(document.querySelectorAll(".search-panel-match")).toHaveLength(MATCH_DISPLAY_STEP);
		});
		fireEvent.click(screen.getByRole("button", { name: /さらに表示/ }));
		expect(document.querySelectorAll(".search-panel-match")).toHaveLength(MATCH_DISPLAY_STEP * 2);

		mockedSearchFiles.mockResolvedValue({
			results: results("/workspace/other.md", MATCH_DISPLAY_STEP + 200),
			truncated: false,
		});
		search("other");

		await waitFor(() => {
			expect(screen.getByText("1 ファイル中 700 件")).toBeTruthy();
		});
		expect(document.querySelectorAll(".search-panel-match")).toHaveLength(MATCH_DISPLAY_STEP);
	});
});
