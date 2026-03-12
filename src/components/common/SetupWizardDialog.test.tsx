import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "../../stores/toast";

vi.mock("../../lib/commands", () => ({
	createDirectory: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn(),
}));

vi.mock("../../lib/export", () => ({
	getDefaultPromptTemplate: vi.fn(() => "default-prompt-template"),
}));

vi.mock("../../lib/scripta-config", () => ({
	fileExists: vi.fn(),
	getScriptaDir: vi.fn((ws: string) => `${ws}/.scripta`),
	getReadmeTemplatePath: vi.fn((ws: string) => `${ws}/README.md`),
	getClaudeMdTemplatePath: vi.fn((ws: string) => `${ws}/CLAUDE.md`),
	getGitignorePath: vi.fn((ws: string) => `${ws}/.gitignore`),
	getSyntaxGuidePath: vi.fn((ws: string) => `${ws}/.scripta/syntax-guide.md`),
	getScriptaPromptTemplatePath: vi.fn((ws: string) => `${ws}/.scripta/prompt-template.md`),
	markWorkspaceInitialized: vi.fn().mockResolvedValue(undefined),
	README_TEMPLATE: "# README",
	CLAUDE_MD_TEMPLATE: "# CLAUDE.md",
	GITIGNORE_TEMPLATE: ".scripta/\n",
	SYNTAX_GUIDE_TEMPLATE: "# syntax guide",
}));

const { writeFile } = await import("../../lib/commands");
const { fileExists, markWorkspaceInitialized } = await import("../../lib/scripta-config");
const { SetupWizardDialog } = await import("./SetupWizardDialog");

const mockedWriteFile = writeFile as Mock;
const mockedFileExists = fileExists as Mock;
const mockedMarkInitialized = markWorkspaceInitialized as Mock;

const defaultProps = {
	open: true,
	onClose: vi.fn(),
	workspacePath: "/workspace",
	onComplete: vi.fn(),
};

function renderDialog(overrides: Partial<typeof defaultProps> = {}) {
	const props = { ...defaultProps, ...overrides };
	return render(<SetupWizardDialog {...props} />);
}

beforeEach(() => {
	vi.clearAllMocks();
	useToastStore.setState({ toasts: [] });
	mockedFileExists.mockResolvedValue(false);
});

describe("SetupWizardDialog", () => {
	it("open=false で非表示", () => {
		renderDialog({ open: false });
		expect(screen.queryByText("ワークスペースのセットアップ")).not.toBeInTheDocument();
	});

	it("タイトルと説明が表示される", () => {
		renderDialog();
		expect(screen.getByText("ワークスペースのセットアップ")).toBeInTheDocument();
		expect(
			screen.getByText("このワークスペースにテンプレートファイルを作成しますか？"),
		).toBeInTheDocument();
	});

	it("3つのオプションが表示される", () => {
		renderDialog();
		expect(screen.getByText("スキップ")).toBeInTheDocument();
		expect(screen.getByText("基本")).toBeInTheDocument();
		expect(screen.getByText("エンジニア向け")).toBeInTheDocument();
	});

	it("「スキップ」クリックでマーカーのみ作成", async () => {
		const onComplete = vi.fn();
		const onClose = vi.fn();
		renderDialog({ onComplete, onClose });

		await userEvent.click(screen.getByText("スキップ"));

		expect(mockedMarkInitialized).toHaveBeenCalledWith("/workspace");
		expect(mockedWriteFile).not.toHaveBeenCalled();
		expect(onComplete).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it("「基本」クリックで README.md, .gitignore, syntax-guide.md を作成", async () => {
		const onComplete = vi.fn();
		const onClose = vi.fn();
		renderDialog({ onComplete, onClose });

		await userEvent.click(screen.getByText("基本"));

		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/README.md", "# README");
		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/.gitignore", ".scripta/\n");
		expect(mockedWriteFile).toHaveBeenCalledWith(
			"/workspace/.scripta/syntax-guide.md",
			"# syntax guide",
		);
		expect(mockedMarkInitialized).toHaveBeenCalledWith("/workspace");
		expect(onComplete).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it("「エンジニア向け」クリックで README.md, CLAUDE.md, prompt-template.md を作成", async () => {
		const onComplete = vi.fn();
		const onClose = vi.fn();
		renderDialog({ onComplete, onClose });

		await userEvent.click(screen.getByText("エンジニア向け"));

		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/README.md", expect.any(String));
		expect(mockedWriteFile).toHaveBeenCalledWith("/workspace/CLAUDE.md", "# CLAUDE.md");
		expect(mockedWriteFile).toHaveBeenCalledWith(
			"/workspace/.scripta/prompt-template.md",
			"default-prompt-template",
		);
		expect(mockedMarkInitialized).toHaveBeenCalledWith("/workspace");
		expect(onComplete).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it("既存ファイルは上書きしない", async () => {
		mockedFileExists.mockResolvedValue(true);
		renderDialog();

		await userEvent.click(screen.getByText("エンジニア向け"));

		// writeFile should not be called for existing files
		expect(mockedWriteFile).not.toHaveBeenCalledWith("/workspace/README.md", expect.any(String));
		expect(mockedWriteFile).not.toHaveBeenCalledWith("/workspace/CLAUDE.md", expect.any(String));
		// markWorkspaceInitialized should still be called
		expect(mockedMarkInitialized).toHaveBeenCalled();
	});

	it("X ボタンで markWorkspaceInitialized → onComplete → onClose が呼ばれる", async () => {
		const onComplete = vi.fn();
		const onClose = vi.fn();
		renderDialog({ onComplete, onClose });
		await userEvent.click(screen.getByLabelText("閉じる"));
		expect(mockedMarkInitialized).toHaveBeenCalledWith("/workspace");
		expect(onComplete).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it("X ボタンで markWorkspaceInitialized が失敗するとダイアログは閉じずトースト表示", async () => {
		mockedMarkInitialized.mockRejectedValueOnce(new Error("disk full"));
		const onComplete = vi.fn();
		const onClose = vi.fn();
		renderDialog({ onComplete, onClose });
		await userEvent.click(screen.getByLabelText("閉じる"));
		expect(onComplete).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		// ダイアログは開いたまま
		expect(screen.getByText("ワークスペースのセットアップ")).toBeInTheDocument();
		// エラートーストが表示される
		const { toasts } = useToastStore.getState();
		expect(toasts).toHaveLength(1);
		expect(toasts[0].type).toBe("error");
		expect(toasts[0].message).toContain("初期化に失敗しました");
	});

	it("オプション選択のエラー時にトースト表示", async () => {
		mockedMarkInitialized.mockRejectedValueOnce(new Error("disk full"));
		renderDialog();

		await userEvent.click(screen.getByText("スキップ"));

		const { toasts } = useToastStore.getState();
		expect(toasts).toHaveLength(1);
		expect(toasts[0].type).toBe("error");
		expect(toasts[0].message).toContain("セットアップに失敗しました");
	});

	it("処理中は X ボタンが無効化される", async () => {
		// markWorkspaceInitialized を遅延させて処理中状態を保つ
		let resolveInit!: () => void;
		mockedMarkInitialized.mockReturnValueOnce(
			new Promise<void>((r) => {
				resolveInit = r;
			}),
		);
		renderDialog();

		// スキップをクリックして処理中にする
		await userEvent.click(screen.getByText("スキップ"));

		// 処理中は X ボタンが disabled
		expect(screen.getByLabelText("閉じる")).toBeDisabled();

		// 処理完了
		resolveInit();
	});
});
