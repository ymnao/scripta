import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// isPdfSupported はモジュールレベルで navigator.platform を参照するため、
// インポート前に platform を設定する
vi.hoisted(() => {
	Object.defineProperty(navigator, "userAgent", {
		value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
		configurable: true,
	});
});

import { useToastStore } from "../../stores/toast";
import { ExportDialog } from "./ExportDialog";

vi.mock("../../lib/export", () => ({
	exportAsHtml: vi.fn(),
	exportAsPdf: vi.fn(),
	exportAsPrompt: vi.fn(),
	getDefaultPromptTemplate: vi.fn(() => "default-template"),
}));

vi.mock("../../lib/scripta-config", () => ({
	getScriptaPromptTemplatePath: vi.fn(() => "/ws/.scripta/prompt-template.md"),
	loadPromptTemplate: vi.fn(),
	savePromptTemplate: vi.fn(),
}));

// Import mocked modules
const { exportAsHtml, exportAsPdf, exportAsPrompt } = await import("../../lib/export");
const { loadPromptTemplate, savePromptTemplate } = await import("../../lib/scripta-config");

const defaultProps = {
	open: true,
	onClose: vi.fn(),
	markdown: "# Hello",
	filePath: "/path/to/file.md",
	workspacePath: "/ws",
	onOpenFile: vi.fn(),
	scriptaDirReady: true,
};

function renderDialog(overrides: Partial<typeof defaultProps> = {}) {
	const props = { ...defaultProps, ...overrides };
	return render(<ExportDialog {...props} />);
}

beforeEach(() => {
	vi.clearAllMocks();
	useToastStore.setState({ toasts: [] });
});

describe("ExportDialog", () => {
	describe("開閉・セクション切り替え", () => {
		it("open=false で非表示", () => {
			renderDialog({ open: false });
			expect(screen.queryByText("エクスポート")).not.toBeInTheDocument();
		});

		it("初期状態で HTML セクションが表示される", () => {
			renderDialog();
			expect(screen.getByText("HTMLとしてエクスポート")).toBeInTheDocument();
		});

		it("タブクリックで PDF セクションに切り替わる", async () => {
			renderDialog();
			await userEvent.click(screen.getByText("PDF"));
			expect(screen.getByText("PDFとしてエクスポート")).toBeInTheDocument();
		});

		it("タブクリックでプロンプトセクションに切り替わる", async () => {
			renderDialog();
			await userEvent.click(screen.getByText("プロンプト"));
			expect(screen.getByText("プロンプトをエクスポート")).toBeInTheDocument();
		});

		it("X ボタンで onClose が呼ばれる", async () => {
			const onClose = vi.fn();
			renderDialog({ onClose });
			await userEvent.click(screen.getByLabelText("閉じる"));
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe("HTML セクション", () => {
		it("テーマセレクトのデフォルトは「システム」", () => {
			renderDialog();
			const select = screen.getByLabelText("テーマ");
			expect(select).toHaveValue("system");
		});

		it("「HTMLとしてエクスポート」クリックで exportAsHtml が呼ばれる", async () => {
			vi.mocked(exportAsHtml).mockResolvedValue(true);
			renderDialog();
			await userEvent.click(screen.getByText("HTMLとしてエクスポート"));
			expect(exportAsHtml).toHaveBeenCalledWith("# Hello", "/path/to/file.md", {
				theme: "system",
			});
		});

		it("成功（true）で onClose が呼ばれる", async () => {
			vi.mocked(exportAsHtml).mockResolvedValue(true);
			const onClose = vi.fn();
			renderDialog({ onClose });
			await userEvent.click(screen.getByText("HTMLとしてエクスポート"));
			expect(onClose).toHaveBeenCalled();
		});

		it("キャンセル（false）で onClose が呼ばれない", async () => {
			vi.mocked(exportAsHtml).mockResolvedValue(false);
			const onClose = vi.fn();
			renderDialog({ onClose });
			await userEvent.click(screen.getByText("HTMLとしてエクスポート"));
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe("PDF セクション", () => {
		async function switchToPdf() {
			await userEvent.click(screen.getByText("PDF"));
		}

		it("「見出しで改ページ」トグルが存在する", async () => {
			renderDialog();
			await switchToPdf();
			expect(screen.getByText("見出しで改ページ")).toBeInTheDocument();
		});

		it("トグル OFF で対象レベルセレクトが非表示", async () => {
			renderDialog();
			await switchToPdf();
			// Toggle off
			await userEvent.click(screen.getByRole("switch", { name: "見出しで改ページ" }));
			expect(screen.queryByText("対象レベル")).not.toBeInTheDocument();
		});

		it("「PDFとしてエクスポート」クリックで exportAsPdf が呼ばれる", async () => {
			vi.mocked(exportAsPdf).mockResolvedValue(true);
			renderDialog();
			await switchToPdf();
			await userEvent.click(screen.getByText("PDFとしてエクスポート"));
			expect(exportAsPdf).toHaveBeenCalled();
		});

		it("成功で onClose が呼ばれる", async () => {
			vi.mocked(exportAsPdf).mockResolvedValue(true);
			const onClose = vi.fn();
			renderDialog({ onClose });
			await switchToPdf();
			await userEvent.click(screen.getByText("PDFとしてエクスポート"));
			expect(onClose).toHaveBeenCalled();
		});
	});

	describe("プロンプトセクション", () => {
		async function switchToPrompt() {
			await userEvent.click(screen.getByText("プロンプト"));
		}

		it("「プロンプトをエクスポート」クリックで exportAsPrompt が呼ばれる", async () => {
			vi.mocked(exportAsPrompt).mockResolvedValue(true);
			vi.mocked(loadPromptTemplate).mockResolvedValue(null);
			renderDialog();
			await switchToPrompt();
			await userEvent.click(screen.getByText("プロンプトをエクスポート"));
			expect(exportAsPrompt).toHaveBeenCalled();
		});

		it("成功で onClose が呼ばれる", async () => {
			vi.mocked(exportAsPrompt).mockResolvedValue(true);
			vi.mocked(loadPromptTemplate).mockResolvedValue(null);
			const onClose = vi.fn();
			renderDialog({ onClose });
			await switchToPrompt();
			await userEvent.click(screen.getByText("プロンプトをエクスポート"));
			expect(onClose).toHaveBeenCalled();
		});

		it("workspacePath ありで「テンプレートをカスタマイズ」リンク表示", async () => {
			renderDialog({ workspacePath: "/ws" });
			await switchToPrompt();
			expect(screen.getByText("テンプレートをカスタマイズ")).toBeInTheDocument();
		});

		it("workspacePath なしでリンク非表示", async () => {
			renderDialog({ workspacePath: undefined });
			await switchToPrompt();
			expect(screen.queryByText("テンプレートをカスタマイズ")).not.toBeInTheDocument();
		});

		it("カスタマイズクリックでテンプレート未作成時は savePromptTemplate → onClose → onOpenFile", async () => {
			vi.mocked(loadPromptTemplate).mockResolvedValue(null);
			vi.mocked(savePromptTemplate).mockResolvedValue(undefined);
			const onOpenFile = vi.fn();
			const onClose = vi.fn();
			renderDialog({ onOpenFile, onClose });
			await switchToPrompt();
			await userEvent.click(screen.getByText("テンプレートをカスタマイズ"));
			expect(savePromptTemplate).toHaveBeenCalledWith("/ws", "default-template");
			expect(onClose).toHaveBeenCalled();
			expect(onOpenFile).toHaveBeenCalledWith("/ws/.scripta/prompt-template.md");
		});

		it("カスタマイズクリックでテンプレート既存時は savePromptTemplate を呼ばず onClose → onOpenFile", async () => {
			vi.mocked(loadPromptTemplate).mockResolvedValue("existing-template");
			const onOpenFile = vi.fn();
			const onClose = vi.fn();
			renderDialog({ onOpenFile, onClose });
			await switchToPrompt();
			await userEvent.click(screen.getByText("テンプレートをカスタマイズ"));
			expect(savePromptTemplate).not.toHaveBeenCalled();
			expect(onClose).toHaveBeenCalled();
			expect(onOpenFile).toHaveBeenCalledWith("/ws/.scripta/prompt-template.md");
		});

		it("scriptaDirReady=false でテンプレート未作成時、確認UI→作成クリックで savePromptTemplate → onClose → onOpenFile", async () => {
			vi.mocked(loadPromptTemplate).mockResolvedValue(null);
			vi.mocked(savePromptTemplate).mockResolvedValue(undefined);
			const onOpenFile = vi.fn();
			const onClose = vi.fn();
			const onScriptaDirConfirm = vi.fn();
			renderDialog({
				onOpenFile,
				onClose,
				scriptaDirReady: false,
				onScriptaDirConfirm,
			} as Partial<typeof defaultProps>);
			await switchToPrompt();

			// 1回目のクリックで確認UIが表示される
			await userEvent.click(screen.getByText("テンプレートをカスタマイズ"));
			expect(savePromptTemplate).not.toHaveBeenCalled();
			expect(screen.getByText(/\.scripta\/ フォルダを作成します/)).toBeInTheDocument();

			// 「作成」ボタンをクリック
			await userEvent.click(screen.getByText("作成", { selector: "button" }));
			expect(onScriptaDirConfirm).toHaveBeenCalled();
			expect(savePromptTemplate).toHaveBeenCalledWith("/ws", "default-template");
			expect(onClose).toHaveBeenCalled();
			expect(onOpenFile).toHaveBeenCalledWith("/ws/.scripta/prompt-template.md");
		});
	});

	describe("エラーハンドリング", () => {
		it("exportAsHtml が throw → トースト表示", async () => {
			vi.mocked(exportAsHtml).mockRejectedValue(new Error("fail"));
			renderDialog();
			await userEvent.click(screen.getByText("HTMLとしてエクスポート"));
			const { toasts } = useToastStore.getState();
			expect(toasts).toHaveLength(1);
			expect(toasts[0].type).toBe("error");
			expect(toasts[0].message).toContain("HTMLエクスポートに失敗しました");
		});
	});
});
