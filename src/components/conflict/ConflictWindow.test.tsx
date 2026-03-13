import { act, render, screen } from "@testing-library/react";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEmit = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/event", () => ({
	emit: (...args: unknown[]) => mockEmit(...args),
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ close: mockClose }),
}));

vi.mock("../../lib/commands", () => ({
	gitCheckRepo: vi.fn().mockResolvedValue(true),
	gitGetConflictedFiles: vi.fn(),
	gitGetConflictContent: vi.fn(),
	gitResolveConflict: vi.fn(),
	gitAddAll: vi.fn(),
	gitFinishConflictResolution: vi.fn(),
}));

vi.mock("./ConflictDiffView", () => ({
	ConflictDiffView: () => <div data-testid="conflict-diff-view" />,
}));

vi.mock("./ConflictFileList", () => ({
	ConflictFileList: () => <div data-testid="conflict-file-list" />,
}));

const { gitGetConflictedFiles } = await import("../../lib/commands");
const { ConflictWindow } = await import("./ConflictWindow");
const mockedGitGetConflictedFiles = gitGetConflictedFiles as Mock;

describe("ConflictWindow", () => {
	beforeEach(() => {
		vi.stubGlobal("location", { search: "?workspacePath=/test/workspace" });
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
		expect(mockEmit).toHaveBeenCalledWith("conflict-resolved");
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
		mockedGitGetConflictedFiles.mockRejectedValue(new Error("git not found"));

		await act(async () => {
			render(<ConflictWindow />);
		});

		// Should show the error message, NOT auto-close
		expect(screen.getByText("Error: git not found")).toBeInTheDocument();
		expect(mockEmit).not.toHaveBeenCalled();
		expect(mockClose).not.toHaveBeenCalled();
	});
});
