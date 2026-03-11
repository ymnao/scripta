import { FileText, FolderOpen, Settings, X } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { createDirectory, writeFile } from "../../lib/commands";
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
	getScriptaDir,
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
		} catch {
			// マーカー書き込み失敗時はダイアログを閉じるだけ
			onClose();
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
				// Helper: ensure .scripta/ exists
				const ensureScriptaDir = async () => {
					try {
						await createDirectory(getScriptaDir(workspacePath));
					} catch {
						// directory may already exist
					}
				};

				// Helper: write file only if it doesn't already exist
				const writeIfNotExists = async (path: string, content: string) => {
					if (!(await fileExists(path))) {
						await writeFile(path, content);
					}
				};

				if (option === "basic" || option === "engineer") {
					await ensureScriptaDir();

					await writeIfNotExists(getReadmeTemplatePath(workspacePath), README_TEMPLATE);
					await writeIfNotExists(getGitignorePath(workspacePath), GITIGNORE_TEMPLATE);
					await writeIfNotExists(getSyntaxGuidePath(workspacePath), SYNTAX_GUIDE_TEMPLATE);
				}

				if (option === "engineer") {
					await ensureScriptaDir();

					await writeIfNotExists(getClaudeMdTemplatePath(workspacePath), CLAUDE_MD_TEMPLATE);
					await writeIfNotExists(
						getScriptaPromptTemplatePath(workspacePath),
						getDefaultPromptTemplate(),
					);
				}

				// Mark as initialized
				await markWorkspaceInitialized(workspacePath);

				onComplete();

				const messages: Record<SetupOption, string> = {
					skip: "ワークスペースを初期化しました",
					basic: "テンプレートファイルを作成しました",
					engineer: "テンプレートファイルを作成しました",
				};
				addToast("warning", messages[option]);

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
