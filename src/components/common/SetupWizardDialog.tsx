import { FileText, FolderOpen, Settings, X } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { writeNewFile } from "../../lib/commands";
import { getDefaultPromptTemplate } from "../../lib/export";
import {
	CLAUDE_MD_TEMPLATE,
	GITIGNORE_TEMPLATE,
	README_TEMPLATE,
	SYNTAX_GUIDE_TEMPLATE,
	fileExists,
	getClaudeMdTemplatePath,
	getGitignorePath,
	getReadmeTemplatePath,
	getScriptaPromptTemplatePath,
	getSyntaxGuidePath,
	markWorkspaceInitialized,
} from "../../lib/scripta-config";
import { useToastStore } from "../../stores/toast";
import { DialogBase } from "./DialogBase";

interface SetupWizardDialogProps {
	open: boolean;
	onClose: () => void;
	workspacePath: string;
	onComplete: () => void;
}

type SetupOption = "skip" | "basic" | "engineer";

interface OptionCardProps {
	icon: React.ReactNode;
	title: string;
	description: string;
	files: string[];
	selected: boolean;
	onClick: () => void;
	disabled: boolean;
}

function OptionCard({
	icon,
	title,
	description,
	files,
	selected,
	onClick,
	disabled,
}: OptionCardProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={`w-full rounded-lg border p-3 text-left transition-colors ${
				selected
					? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
					: "border-border hover:border-blue-300 hover:bg-bg-secondary dark:hover:border-blue-700"
			} disabled:cursor-not-allowed disabled:opacity-50`}
		>
			<div className="flex items-start gap-2.5">
				<span className="mt-0.5 shrink-0 text-text-secondary">{icon}</span>
				<div className="min-w-0 flex-1">
					<p className="text-xs font-semibold text-text-primary">{title}</p>
					<p className="mt-0.5 text-[11px] text-text-secondary">{description}</p>
					{files.length > 0 && (
						<div className="mt-1.5 space-y-0.5">
							{files.map((file) => (
								<p key={file} className="text-[10px] text-text-secondary/70">
									{file}
								</p>
							))}
						</div>
					)}
				</div>
			</div>
		</button>
	);
}

export function SetupWizardDialog({
	open,
	onClose,
	workspacePath,
	onComplete,
}: SetupWizardDialogProps) {
	const titleId = useId();
	const descId = useId();
	const [processing, setProcessing] = useState(false);
	const [selectedOption, setSelectedOption] = useState<SetupOption | null>(null);

	// X ボタン・Escape・オーバーレイクリック: スキップと同じ扱いにする。
	// 初期化マーカーを書き込み、設定 > ワークスペースからテンプレートを後で追加可能。
	const handleDismiss = useCallback(async () => {
		if (processing) return;
		setProcessing(true);
		try {
			await markWorkspaceInitialized(workspacePath);
			onComplete();
			onClose();
		} catch (err) {
			// マーカー書き込み失敗時はダイアログを閉じず、リトライ可能にする
			useToastStore
				.getState()
				.addToast(
					"error",
					`初期化に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
				);
		} finally {
			setProcessing(false);
		}
	}, [processing, workspacePath, onComplete, onClose]);

	const handleSetup = useCallback(
		async (option: SetupOption) => {
			setSelectedOption(option);
			setProcessing(true);
			const addToast = useToastStore.getState().addToast;

			try {
				// writeNewFile は Rust 側で create_new(true) を使い、既存ファイルがあれば
				// 原子的に失敗する。TOCTOU レースなしで「上書きしない」を保証。
				const tryWriteNew = async (path: string, content: string) => {
					try {
						await writeNewFile(path, content);
						return true;
					} catch {
						// ファイルが既に存在する場合はスキップ。
						// 権限不足やディスクフル等で本当に作成できなかった場合は再送出。
						if (await fileExists(path)) return false;
						throw new Error(`ファイルの作成に失敗しました: ${path}`);
					}
				};

				let createdCount = 0;

				if (option === "basic" || option === "engineer") {
					if (await tryWriteNew(getReadmeTemplatePath(workspacePath), README_TEMPLATE))
						createdCount++;
					if (await tryWriteNew(getGitignorePath(workspacePath), GITIGNORE_TEMPLATE))
						createdCount++;
					if (await tryWriteNew(getSyntaxGuidePath(workspacePath), SYNTAX_GUIDE_TEMPLATE))
						createdCount++;
				}

				if (option === "engineer") {
					if (await tryWriteNew(getClaudeMdTemplatePath(workspacePath), CLAUDE_MD_TEMPLATE))
						createdCount++;
					if (
						await tryWriteNew(
							getScriptaPromptTemplatePath(workspacePath),
							getDefaultPromptTemplate(),
						)
					)
						createdCount++;
				}

				// Mark as initialized
				await markWorkspaceInitialized(workspacePath);

				onComplete();

				if (option === "skip" || createdCount === 0) {
					addToast("warning", "ワークスペースを初期化しました");
				} else {
					addToast("warning", `${createdCount} 件のテンプレートファイルを作成しました`);
				}

				onClose();
			} catch (err) {
				addToast(
					"error",
					`セットアップに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
				);
			} finally {
				setProcessing(false);
				setSelectedOption(null);
			}
		},
		[workspacePath, onComplete, onClose],
	);

	return (
		<DialogBase
			open={open}
			onClose={handleDismiss}
			ariaLabelledBy={titleId}
			ariaDescribedBy={descId}
			className="max-w-md"
			preventClose={processing}
		>
			<div className="flex items-center justify-between">
				<h2 id={titleId} className="text-sm font-semibold text-text-primary">
					ワークスペースのセットアップ
				</h2>
				<button
					type="button"
					onClick={() => void handleDismiss()}
					disabled={processing}
					aria-label="閉じる"
					className="rounded p-0.5 text-text-secondary hover:bg-black/10 hover:text-text-primary disabled:opacity-50 dark:hover:bg-white/10"
				>
					<X size={16} />
				</button>
			</div>

			<p id={descId} className="mt-2 text-xs text-text-secondary">
				このワークスペースにテンプレートファイルを作成しますか？
			</p>

			<div className="mt-3 space-y-2">
				<OptionCard
					icon={<FolderOpen size={16} />}
					title="スキップ"
					description="テンプレートを作成しません"
					files={[]}
					selected={selectedOption === "skip"}
					onClick={() => void handleSetup("skip")}
					disabled={processing}
				/>
				<OptionCard
					icon={<FileText size={16} />}
					title="基本"
					description="README と記法ガイドを作成します"
					files={["README.md", ".gitignore", ".scripta/syntax-guide.md"]}
					selected={selectedOption === "basic"}
					onClick={() => void handleSetup("basic")}
					disabled={processing}
				/>
				<OptionCard
					icon={<Settings size={16} />}
					title="エンジニア向け"
					description="上記に加え、AI 開発ガイドラインを作成します"
					files={[
						"README.md",
						"CLAUDE.md",
						".gitignore",
						".scripta/syntax-guide.md",
						".scripta/prompt-template.md",
					]}
					selected={selectedOption === "engineer"}
					onClick={() => void handleSetup("engineer")}
					disabled={processing}
				/>
			</div>
		</DialogBase>
	);
}
