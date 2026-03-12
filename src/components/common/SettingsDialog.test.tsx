import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/commands", () => ({
	writeNewFile: vi.fn().mockResolvedValue(undefined),
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

const { writeNewFile } = await import("../../lib/commands");
const { fileExists } = await import("../../lib/scripta-config");
const { SettingsDialog } = await import("./SettingsDialog");

const mockedWriteNewFile = writeNewFile as Mock;
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

	it("既存ファイルに対する作成は writeNewFile の原子的失敗で安全にスキップ", async () => {
		// writeNewFile が失敗するケース（ファイルが既存）
		mockedWriteNewFile.mockRejectedValue(new Error("File exists (os error 17)"));

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

		// writeNewFile は呼ばれたが失敗し、エラーは握りつぶされる
		await waitFor(() => {
			expect(mockedWriteNewFile).toHaveBeenCalledWith("/workspace/README.md", expect.any(String));
		});
	});

	it("workspacePath がない場合はワークスペースセクションが表示されない", async () => {
		await act(async () => {
			render(<SettingsDialog {...defaultProps} workspacePath={null} />);
		});

		expect(screen.queryByText("ワークスペース")).not.toBeInTheDocument();
	});
});
