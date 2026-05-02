import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("../../lib/commands", () => ({
	writeNewFile: vi.fn().mockResolvedValue(undefined),
	openExternal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/export", () => ({
	getDefaultPromptTemplate: vi.fn(() => "default-prompt-template"),
}));

vi.mock("../../lib/scripta-config", () => ({
	fileExists: vi.fn(),
	getTemplateDefinitions: vi.fn((getPromptContent: () => string) => [
		{ name: "README.md", getPath: (ws: string) => `${ws}/README.md`, getContent: () => "# README" },
		{
			name: "CLAUDE.md",
			getPath: (ws: string) => `${ws}/CLAUDE.md`,
			getContent: () => "# CLAUDE.md",
		},
		{
			name: ".gitignore",
			getPath: (ws: string) => `${ws}/.gitignore`,
			getContent: () => ".scripta/\n",
		},
		{
			name: "syntax-guide.md",
			getPath: (ws: string) => `${ws}/.scripta/syntax-guide.md`,
			getContent: () => "# syntax guide",
		},
		{
			name: "prompt-template.md",
			getPath: (ws: string) => `${ws}/.scripta/prompt-template.md`,
			getContent: getPromptContent,
		},
	]),
}));

const { writeNewFile, openExternal } = await import("../../lib/commands");
const { fileExists } = await import("../../lib/scripta-config");
const { KOFI_URL, SettingsDialog } = await import("./SettingsDialog");

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

		// handleCreate 内の fileExists は true を返す（ファイルは既に存在する）
		mockedFileExists.mockResolvedValue(true);

		// README.md の「作成」ボタンをクリック
		const createButtons = screen.getAllByText("作成");
		await userEvent.click(createButtons[0]);

		// writeNewFile は呼ばれたが失敗し、fileExists で確認して exists: true に更新
		await waitFor(() => {
			expect(mockedWriteNewFile).toHaveBeenCalledWith("/workspace/README.md", expect.any(String));
		});
	});

	it("権限エラー等で作成失敗した場合はトーストでエラー通知", async () => {
		// writeNewFile が失敗するケース
		mockedWriteNewFile.mockRejectedValue(new Error("Permission denied"));

		await act(async () => {
			render(<SettingsDialog {...defaultProps} />);
		});

		await userEvent.click(screen.getByText("ワークスペース"));

		await waitFor(() => {
			expect(screen.getByText("README.md")).toBeInTheDocument();
		});

		// handleCreate 内の fileExists は false を返す（本当にファイルが存在しない）
		mockedFileExists.mockResolvedValue(false);

		const createButtons = screen.getAllByText("作成");
		await userEvent.click(createButtons[0]);

		await waitFor(() => {
			expect(mockedWriteNewFile).toHaveBeenCalled();
		});
	});

	it("workspacePath がない場合はワークスペースセクションが表示されない", async () => {
		await act(async () => {
			render(<SettingsDialog {...defaultProps} workspacePath={null} />);
		});

		expect(screen.queryByText("ワークスペース")).not.toBeInTheDocument();
	});
});

describe("SettingsDialog about section", () => {
	it("「このアプリについて」セクションでコンテンツが表示される", async () => {
		await act(async () => {
			render(<SettingsDialog {...defaultProps} />);
		});

		await userEvent.click(screen.getByText("このアプリについて"));

		expect(screen.getByText("scripta")).toBeInTheDocument();
		expect(
			screen.getByText("ローカルファイルベースの軽量 Markdown メモアプリ。"),
		).toBeInTheDocument();
		expect(screen.getByText("Ko-fi で応援する")).toBeInTheDocument();
	});

	it("Ko-fi ボタンクリックで open() が正しい URL で呼ばれる", async () => {
		await act(async () => {
			render(<SettingsDialog {...defaultProps} />);
		});

		await userEvent.click(screen.getByText("このアプリについて"));
		await userEvent.click(screen.getByText("Ko-fi で応援する"));

		expect(openExternal).toHaveBeenCalledWith(KOFI_URL);
	});
});
