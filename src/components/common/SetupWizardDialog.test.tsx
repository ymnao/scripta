import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { useToastStore } from "../../stores/toast";

vi.mock("../../lib/commands", () => ({
	writeNewFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/export", () => ({
	getDefaultPromptTemplate: vi.fn(() => "default-prompt-template"),
}));

vi.mock("../../lib/scripta-config", () => ({
	fileExists: vi.fn().mockResolvedValue(true),
	markWorkspaceInitialized: vi.fn().mockResolvedValue(undefined),
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

const { writeNewFile } = await import("../../lib/commands");
const { fileExists, markWorkspaceInitialized } = await import("../../lib/scripta-config");
const { SetupWizardDialog } = await import("./SetupWizardDialog");

const mockedWriteNewFile = writeNewFile as Mock;
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
	// デフォルト: writeNewFile 失敗時の fileExists はファイル既存と判定
	mockedFileExists.mockResolvedValue(true);
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
		expect(mockedWriteNewFile).not.toHaveBeenCalled();
		expect(onComplete).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it("「基本」クリックで README.md, .gitignore, syntax-guide.md を作成", async () => {
		const onComplete = vi.fn();
		const onClose = vi.fn();
		renderDialog({ onComplete, onClose });

		await userEvent.click(screen.getByText("基本"));

		expect(mockedWriteNewFile).toHaveBeenCalledWith("/workspace/README.md", "# README");
		expect(mockedWriteNewFile).toHaveBeenCalledWith("/workspace/.gitignore", ".scripta/\n");
		expect(mockedWriteNewFile).toHaveBeenCalledWith(
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

		expect(mockedWriteNewFile).toHaveBeenCalledWith("/workspace/README.md", expect.any(String));
		expect(mockedWriteNewFile).toHaveBeenCalledWith("/workspace/CLAUDE.md", "# CLAUDE.md");
		expect(mockedWriteNewFile).toHaveBeenCalledWith(
			"/workspace/.scripta/prompt-template.md",
			"default-prompt-template",
		);
		expect(mockedMarkInitialized).toHaveBeenCalledWith("/workspace");
		expect(onComplete).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});

	it("既存ファイルは上書きせず正常完了する", async () => {
		// writeNewFile が全て失敗（既存ファイル）
		mockedWriteNewFile.mockRejectedValue(new Error("File exists"));
		renderDialog();

		await userEvent.click(screen.getByText("エンジニア向け"));

		// markWorkspaceInitialized should still be called
		expect(mockedMarkInitialized).toHaveBeenCalled();
	});

	it("全ファイルが既存の場合、トーストに作成件数ではなく初期化メッセージを表示", async () => {
		// writeNewFile が全て失敗（既存ファイル）
		mockedWriteNewFile.mockRejectedValue(new Error("File exists"));
		renderDialog();

		await userEvent.click(screen.getByText("基本"));

		const { toasts } = useToastStore.getState();
		expect(toasts).toHaveLength(1);
		expect(toasts[0].message).toBe("ワークスペースを初期化しました");
	});

	it("一部ファイルのみ新規作成の場合、作成件数をトーストに表示", async () => {
		// README.md だけ既存（writeNewFile が失敗）、他は成功
		mockedWriteNewFile.mockImplementation(async (path: string) => {
			if (path === "/workspace/README.md") throw new Error("File exists");
		});
		renderDialog();

		await userEvent.click(screen.getByText("基本"));

		const { toasts } = useToastStore.getState();
		expect(toasts).toHaveLength(1);
		expect(toasts[0].message).toBe("2 件のテンプレートファイルを作成しました");
	});

	it("権限エラー等でファイルが実際に作成されなかった場合はエラートースト表示", async () => {
		// writeNewFile が失敗し、fileExists も false（ファイルが存在しない＝本当のエラー）
		mockedWriteNewFile.mockRejectedValue(new Error("Permission denied"));
		mockedFileExists.mockResolvedValue(false);
		renderDialog();

		await userEvent.click(screen.getByText("基本"));

		const { toasts } = useToastStore.getState();
		expect(toasts).toHaveLength(1);
		expect(toasts[0].type).toBe("error");
		expect(toasts[0].message).toContain("セットアップに失敗しました");
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
