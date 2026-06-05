import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { encodeIpcError } from "../../types/errors";

vi.mock("../../lib/commands", () => ({
	gitCheckRepo: vi.fn().mockResolvedValue(true),
	gitGetConflictedFiles: vi.fn(),
	gitGetConflictContent: vi.fn(),
	gitResolveConflict: vi.fn(),
	gitFinishConflictResolution: vi.fn(),
	emitConflictResolved: vi.fn().mockResolvedValue(undefined),
	closeWindow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./ConflictDiffView", () => ({
	ConflictDiffView: () => <div data-testid="conflict-diff-view" />,
}));

vi.mock("./ConflictFileList", () => ({
	ConflictFileList: () => <div data-testid="conflict-file-list" />,
}));

const { gitGetConflictedFiles, emitConflictResolved, closeWindow } = await import(
	"../../lib/commands"
);
const { ConflictWindow } = await import("./ConflictWindow");
const mockedGitGetConflictedFiles = gitGetConflictedFiles as Mock;
const mockEmit = emitConflictResolved as Mock;
const mockClose = closeWindow as Mock;

const TEST_WS = "/test/workspace";

describe("ConflictWindow", () => {
	beforeEach(() => {
		vi.stubGlobal("location", { search: `?workspacePath=${TEST_WS}` });
		mockEmit.mockClear();
		mockClose.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders loading→files=0 transition without hook order violation", async () => {
		// This test validates that all hooks are called unconditionally.
		// Before the fix, a useEffect was placed after the early return for
		// loading state, causing a React hook order violation when
		// loading transitioned from true→false with files=0.
		mockedGitGetConflictedFiles.mockResolvedValue([]);

		await act(async () => {
			render(<ConflictWindow />);
		});

		// Should show loading first, then transition to "no conflicts" state
		// without crashing due to hook order violation.
		expect(screen.getByText("コンフリクトファイルはありません")).toBeInTheDocument();

		// Auto-close should have been triggered (emit + close)
		// emit には現在の workspacePath を渡して broadcast を workspace 単位にする
		expect(mockEmit).toHaveBeenCalledWith(TEST_WS);
		expect(mockClose).toHaveBeenCalled();
	});

	it("shows loading state initially", async () => {
		// Never resolves — stays in loading state
		mockedGitGetConflictedFiles.mockReturnValue(new Promise(() => {}));

		await act(async () => {
			render(<ConflictWindow />);
		});

		expect(screen.getByText("読み込み中...")).toBeInTheDocument();
	});

	it("renders file list when conflicts exist", async () => {
		mockedGitGetConflictedFiles.mockResolvedValue(["file.md"]);
		const { gitGetConflictContent } = await import("../../lib/commands");
		(gitGetConflictContent as Mock).mockResolvedValue({
			ours: "local content",
			theirs: "remote content",
		});

		await act(async () => {
			render(<ConflictWindow />);
		});

		expect(screen.getByTestId("conflict-file-list")).toBeInTheDocument();
		expect(screen.getByTestId("conflict-diff-view")).toBeInTheDocument();
	});

	it("shows error when workspacePath is missing", async () => {
		vi.stubGlobal("location", { search: "?conflict=true" });

		await act(async () => {
			render(<ConflictWindow />);
		});

		// Should show error, not hang on loading
		expect(
			screen.getByText("workspacePath が URL パラメータに指定されていません。"),
		).toBeInTheDocument();
		expect(screen.queryByText("読み込み中...")).not.toBeInTheDocument();
		expect(mockEmit).not.toHaveBeenCalled();
		expect(mockClose).not.toHaveBeenCalled();
	});

	it("does not auto-close when gitGetConflictedFiles fails", async () => {
		// 実 IPC 経路で renderer に届く形（kind が sentinel payload として message に載った
		// Error）を模す。ConflictWindow は translateError 経由で localize して表示すること
		// （生の sentinel 文字列を出さない＝contextBridge 対応の regression ガード）。
		mockedGitGetConflictedFiles.mockRejectedValue(
			new Error(
				encodeIpcError({
					kind: "GIT_NO_REMOTE_ACCESS",
					message: "fatal: could not read from remote repository",
				}),
			),
		);

		await act(async () => {
			render(<ConflictWindow />);
		});

		// Should show the localized error message, NOT auto-close（生 sentinel を出さない）。
		expect(screen.getByText("リモートリポジトリにアクセスできません")).toBeInTheDocument();
		expect(screen.queryByText(/SCRIPTA_STRUCTURED_ERR/)).not.toBeInTheDocument();
		expect(mockEmit).not.toHaveBeenCalled();
		expect(mockClose).not.toHaveBeenCalled();
	});
});
