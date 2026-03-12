import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/commands", () => ({
	writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/export", () => ({
	getDefaultPromptTemplate: vi.fn(() => "default-prompt-template"),
}));

vi.mock("../../lib/scripta-config", () => ({
	fileExists: vi.fn(),
	getReadmeTemplatePath: vi.fn((ws: string) => `${ws}/README.md`),
	getClaudeMdTemplatePath: vi.fn((ws: string) => `${ws}/CLAUDE.md`),
	getGitignorePath: vi.fn((ws: string) => `${ws}/.gitignore`),
	getSyntaxGuidePath: vi.fn((ws: string) => `${ws}/.scripta/syntax-guide.md`),
	getScriptaPromptTemplatePath: vi.fn((ws: string) => `${ws}/.scripta/prompt-template.md`),
	README_TEMPLATE: "# README",
	CLAUDE_MD_TEMPLATE: "# CLAUDE.md",
	GITIGNORE_TEMPLATE: ".scripta/\n",
	SYNTAX_GUIDE_TEMPLATE: "# syntax guide",
}));

const { writeFile } = await import("../../lib/commands");
const { fileExists } = await import("../../lib/scripta-config");
const { SettingsDialog } = await import("./SettingsDialog");

const mockedWriteFile = writeFile as Mock;
const mockedFileExists = fileExists as Mock;

const defaultProps = {
	open: true,
	onClose: vi.fn(),
	workspacePath: "/workspace",
	onOpenFile: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
	// すべてのファイルが未作成の状態
	mockedFileExists.mockResolvedValue(false);
});

describe("SettingsDialog workspace section", () => {
	it("ワークスペースセクションでテンプレートファイル一覧を表示", async () => {
		await act(async () => {
			render(<SettingsDialog {...defaultProps} />);
		});

		// ワークスペースセクションに切り替え
		await userEvent.click(screen.getByText("ワークスペース"));

		await waitFor(() => {
			expect(screen.getByText("README.md")).toBeInTheDocument();
		});
		expect(screen.getByText("CLAUDE.md")).toBeInTheDocument();
		expect(screen.getByText(".gitignore")).toBeInTheDocument();
	});

	it("作成ボタンクリック前に fileExists を再確認し、既存なら上書きしない", async () => {
		// 初回チェック時は未作成、作成ボタンクリック時は既存
		let callCount = 0;
		mockedFileExists.mockImplementation(async (path: string) => {
			if (path === "/workspace/README.md") {
				callCount++;
				// 初回（一覧表示時）は false、2回目（作成クリック時）は true
				return callCount > 1;
			}
			return false;
		});

		await act(async () => {
			render(<SettingsDialog {...defaultProps} />);
		});

		await userEvent.click(screen.getByText("ワークスペース"));

		await waitFor(() => {
			expect(screen.getByText("README.md")).toBeInTheDocument();
		});

		// README.md の「作成」ボタンをクリック
		const createButtons = screen.getAllByText("作成");
		await userEvent.click(createButtons[0]);

		// fileExists が再チェックされた
		await waitFor(() => {
			// 初回（一覧表示）+ 2回目（作成クリック時）で 2回以上呼ばれる
			expect(mockedFileExists).toHaveBeenCalledWith("/workspace/README.md");
		});

		// writeFile は呼ばれない（既存ファイルなので上書きしない）
		expect(mockedWriteFile).not.toHaveBeenCalledWith("/workspace/README.md", expect.any(String));
	});

	it("workspacePath がない場合はワークスペースセクションが表示されない", async () => {
		await act(async () => {
			render(<SettingsDialog {...defaultProps} workspacePath={null} />);
		});

		expect(screen.queryByText("ワークスペース")).not.toBeInTheDocument();
	});
});
