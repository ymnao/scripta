import { Coffee, ExternalLink, Plus, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { openExternal, writeNewFile } from "../../lib/commands";
import { getDefaultPromptTemplate } from "../../lib/export";
import { fileExists, getTemplateDefinitions } from "../../lib/scripta-config";
import type { FontFamily, ThemePreference } from "../../lib/store";
import { useGitSyncStore } from "../../stores/git-sync";
import { useSettingsStore } from "../../stores/settings";
import { useThemeStore } from "../../stores/theme";
import { useToastStore } from "../../stores/toast";
import { useWorkspaceStore } from "../../stores/workspace";
import type { SyncMethod } from "../../types/git-sync";
import { DialogBase } from "./DialogBase";
import { NumberInput, SelectInput, TextInput, Toggle } from "./FormInputs";
import { SidebarDialogLayout } from "./SidebarDialogLayout";

export const KOFI_URL = "https://ko-fi.com/yamanao";

interface SettingsDialogProps {
	open: boolean;
	onClose: () => void;
	workspacePath?: string | null;
	onOpenFile?: (path: string) => void;
	onManualSync?: () => void;
}

const themeOptions: { value: ThemePreference; label: string }[] = [
	{ value: "system", label: "システム" },
	{ value: "light", label: "ライト" },
	{ value: "dark", label: "ダーク" },
];

const fontFamilyOptions: { value: FontFamily; label: string }[] = [
	{ value: "monospace", label: "等幅 (Monospace)" },
	{ value: "sans-serif", label: "ゴシック (Sans-serif)" },
	{ value: "serif", label: "明朝 (Serif)" },
];

const syncMethodOptions: { value: SyncMethod; label: string }[] = [
	{ value: "merge", label: "Merge" },
	{ value: "rebase", label: "Rebase" },
];

type Section = "appearance" | "editor" | "save" | "scratchpad" | "git-sync" | "workspace" | "about";

const baseSections: { key: Section; label: string }[] = [
	{ key: "appearance", label: "外観" },
	{ key: "editor", label: "エディタ" },
	{ key: "save", label: "保存" },
	{ key: "scratchpad", label: "スクラッチパッド" },
];

interface TemplateFileStatus {
	name: string;
	path: string;
	exists: boolean;
	getContent: () => string;
}

function WorkspaceSection({
	workspacePath,
	onOpenFile,
	onClose,
}: {
	workspacePath: string;
	onOpenFile?: (path: string) => void;
	onClose: () => void;
}) {
	const [files, setFiles] = useState<TemplateFileStatus[]>([]);
	const [loading, setLoading] = useState(true);
	const [creatingPaths, setCreatingPaths] = useState<Set<string>>(new Set());
	const bumpFileTreeVersion = useWorkspaceStore.getState().bumpFileTreeVersion;

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setFiles([]);

		(async () => {
			const definitions = getTemplateDefinitions(getDefaultPromptTemplate);
			const templates = definitions.map((def) => ({
				name: def.name,
				path: def.getPath(workspacePath),
				getContent: def.getContent,
			}));

			try {
				const results = await Promise.all(
					templates.map(async (t) => ({
						...t,
						exists: await fileExists(t.path),
					})),
				);

				if (!cancelled) {
					setFiles(results);
					setLoading(false);
				}
			} catch {
				if (!cancelled) {
					useToastStore
						.getState()
						.addToast("error", "テンプレートファイルの存在確認に失敗しました");
					setFiles(templates.map((t) => ({ ...t, exists: false })));
					setLoading(false);
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [workspacePath]);

	const handleCreate = useCallback(
		async (file: TemplateFileStatus) => {
			if (creatingPaths.has(file.path)) return;
			setCreatingPaths((prev) => new Set(prev).add(file.path));
			try {
				// writeNewFile は Rust 側で create_new(true) を使い、既存ファイルがあれば
				// 原子的に失敗する。TOCTOU レースなしで「上書きしない」を保証。
				await writeNewFile(file.path, file.getContent());
				setFiles((prev) => prev.map((f) => (f.path === file.path ? { ...f, exists: true } : f)));
				bumpFileTreeVersion();
			} catch {
				// いずれのエラーでも実際の存在状態を確認してから UI を更新する。
				// fileExists 自体の失敗はこのハンドラ全体を reject させないよう内部で処理する。
				try {
					const exists = await fileExists(file.path);
					setFiles((prev) => prev.map((f) => (f.path === file.path ? { ...f, exists } : f)));
					if (!exists) {
						useToastStore.getState().addToast("error", `${file.name} の作成に失敗しました`);
					}
				} catch {
					useToastStore
						.getState()
						.addToast("error", `${file.name} の作成に失敗しました（存在確認に失敗）`);
				}
			} finally {
				setCreatingPaths((prev) => {
					const next = new Set(prev);
					next.delete(file.path);
					return next;
				});
			}
		},
		[bumpFileTreeVersion, creatingPaths],
	);

	const handleOpen = useCallback(
		(path: string) => {
			onOpenFile?.(path);
			onClose();
		},
		[onOpenFile, onClose],
	);

	if (loading) {
		return <p className="text-xs text-text-secondary">読み込み中...</p>;
	}

	return (
		<div className="space-y-2">
			<p className="text-[11px] text-text-secondary">テンプレートファイル</p>
			{files.map((file) => (
				<div
					key={file.path}
					className="flex items-center justify-between rounded-md bg-bg-secondary px-3 py-2"
				>
					<div className="min-w-0 flex-1">
						<p className="text-xs font-medium text-text-primary">{file.name}</p>
						<p className="text-[10px] text-text-secondary">{file.exists ? "作成済み" : "未作成"}</p>
					</div>
					{file.exists ? (
						<button
							type="button"
							onClick={() => handleOpen(file.path)}
							className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/30"
						>
							<ExternalLink size={12} />
							開く
						</button>
					) : (
						<button
							type="button"
							onClick={() => void handleCreate(file)}
							disabled={creatingPaths.has(file.path)}
							className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:text-blue-400 dark:hover:bg-blue-950/30"
						>
							<Plus size={12} />
							作成
						</button>
					)}
				</div>
			))}
		</div>
	);
}

export function SettingsDialog({
	open,
	onClose,
	workspacePath,
	onOpenFile,
	onManualSync,
}: SettingsDialogProps) {
	const titleId = useId();
	const gitAvailable = useGitSyncStore((s) => s.gitAvailable);
	const gitReady = useGitSyncStore((s) => s.gitReady);
	const sections: { key: Section; label: string }[] = [
		...baseSections,
		...(gitAvailable ? [{ key: "git-sync" as Section, label: "Git 同期" }] : []),
		...(workspacePath ? [{ key: "workspace" as Section, label: "ワークスペース" }] : []),
		{ key: "about" as Section, label: "このアプリについて" },
	];
	const [activeSection, setActiveSection] = useState<Section>("appearance");

	// workspacePath が消えて sections から "workspace" が外れた場合のフォールバック
	const validSection = sections.some((s) => s.key === activeSection) ? activeSection : "appearance";

	const preference = useThemeStore((s) => s.preference);
	const setPreference = useThemeStore((s) => s.setPreference);
	const showLineNumbers = useSettingsStore((s) => s.showLineNumbers);
	const setShowLineNumbers = useSettingsStore((s) => s.setShowLineNumbers);
	const highlightActiveLine = useSettingsStore((s) => s.highlightActiveLine);
	const setHighlightActiveLine = useSettingsStore((s) => s.setHighlightActiveLine);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const setFontSize = useSettingsStore((s) => s.setFontSize);
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const setFontFamily = useSettingsStore((s) => s.setFontFamily);
	const autoSaveDelay = useSettingsStore((s) => s.autoSaveDelay);
	const setAutoSaveDelay = useSettingsStore((s) => s.setAutoSaveDelay);
	const trimTrailingWhitespace = useSettingsStore((s) => s.trimTrailingWhitespace);
	const setTrimTrailingWhitespace = useSettingsStore((s) => s.setTrimTrailingWhitespace);
	const showLinkCards = useSettingsStore((s) => s.showLinkCards);
	const setShowLinkCards = useSettingsStore((s) => s.setShowLinkCards);
	const scratchpadVolatile = useSettingsStore((s) => s.scratchpadVolatile);
	const setScratchpadVolatile = useSettingsStore((s) => s.setScratchpadVolatile);

	const gitSyncEnabled = useGitSyncStore((s) => s.gitSyncEnabled);
	const setGitSyncEnabled = useGitSyncStore((s) => s.setGitSyncEnabled);
	const autoCommitInterval = useGitSyncStore((s) => s.autoCommitInterval);
	const setAutoCommitInterval = useGitSyncStore((s) => s.setAutoCommitInterval);
	const autoPullInterval = useGitSyncStore((s) => s.autoPullInterval);
	const setAutoPullInterval = useGitSyncStore((s) => s.setAutoPullInterval);
	const autoPushInterval = useGitSyncStore((s) => s.autoPushInterval);
	const setAutoPushInterval = useGitSyncStore((s) => s.setAutoPushInterval);
	const pullBeforePush = useGitSyncStore((s) => s.pullBeforePush);
	const setPullBeforePush = useGitSyncStore((s) => s.setPullBeforePush);
	const syncMethod = useGitSyncStore((s) => s.syncMethod);
	const setSyncMethod = useGitSyncStore((s) => s.setSyncMethod);
	const commitMessage = useGitSyncStore((s) => s.commitMessage);
	const setCommitMessage = useGitSyncStore((s) => s.setCommitMessage);
	const autoPullOnStartup = useGitSyncStore((s) => s.autoPullOnStartup);
	const setAutoPullOnStartup = useGitSyncStore((s) => s.setAutoPullOnStartup);

	return (
		<DialogBase open={open} onClose={onClose} ariaLabelledBy={titleId} size="lg" fixedHeight>
			<div className="flex shrink-0 items-center justify-between">
				<h2 id={titleId} className="text-sm font-semibold text-text-primary">
					設定
				</h2>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close"
					className="rounded p-0.5 text-text-secondary hover:bg-black/10 hover:text-text-primary dark:hover:bg-white/10"
				>
					<X size={16} />
				</button>
			</div>

			<SidebarDialogLayout
				sections={sections}
				activeSection={validSection}
				onSectionChange={(key) => setActiveSection(key as Section)}
				navAriaLabel="設定セクション"
				contentSpacing="tight"
			>
				{validSection === "appearance" && (
					<>
						<SelectInput
							id="theme-select"
							label="テーマ"
							value={preference}
							options={themeOptions}
							onChange={setPreference}
						/>
						<Toggle
							id="line-numbers-toggle"
							label="行番号を表示"
							checked={showLineNumbers}
							onChange={setShowLineNumbers}
						/>
						<Toggle
							id="highlight-active-line-toggle"
							label="アクティブ行をハイライト"
							checked={highlightActiveLine}
							onChange={setHighlightActiveLine}
						/>
					</>
				)}

				{validSection === "editor" && (
					<>
						<NumberInput
							id="font-size-input"
							label="フォントサイズ"
							value={fontSize}
							min={8}
							max={32}
							step={1}
							unit="px"
							onChange={setFontSize}
						/>
						<SelectInput
							id="font-family-select"
							label="フォント"
							value={fontFamily}
							options={fontFamilyOptions}
							onChange={setFontFamily}
						/>
						<Toggle
							id="show-link-cards-toggle"
							label="URLリンクカードを表示"
							checked={showLinkCards}
							onChange={setShowLinkCards}
						/>
					</>
				)}

				{validSection === "save" && (
					<>
						<NumberInput
							id="auto-save-delay-input"
							label="自動保存の遅延"
							value={autoSaveDelay}
							min={500}
							max={10000}
							step={100}
							unit="ms"
							onChange={setAutoSaveDelay}
						/>
						<Toggle
							id="trim-trailing-whitespace-toggle"
							label="行末の空白を削除"
							checked={trimTrailingWhitespace}
							onChange={setTrimTrailingWhitespace}
						/>
					</>
				)}

				{validSection === "scratchpad" && (
					<>
						<Toggle
							id="scratchpad-volatile-toggle"
							label="日替わりでクリア"
							checked={scratchpadVolatile}
							onChange={setScratchpadVolatile}
						/>
						<p className="px-1 text-[10px] leading-relaxed text-text-secondary">
							有効にすると、日付が変わったときにスクラッチパッドの内容を自動的にアーカイブしてクリアします。
						</p>
					</>
				)}

				{validSection === "git-sync" &&
					(gitReady ? (
						<>
							<Toggle
								id="git-sync-enabled-toggle"
								label="Git 同期を有効化"
								checked={gitSyncEnabled}
								onChange={setGitSyncEnabled}
							/>
							<NumberInput
								id="auto-commit-interval-input"
								label="自動コミット間隔"
								value={autoCommitInterval}
								min={0}
								max={1440}
								step={1}
								unit="分"
								onChange={setAutoCommitInterval}
							/>
							<NumberInput
								id="auto-pull-interval-input"
								label="自動 Pull 間隔"
								value={autoPullInterval}
								min={0}
								max={1440}
								step={1}
								unit="分"
								onChange={setAutoPullInterval}
							/>
							<NumberInput
								id="auto-push-interval-input"
								label="自動 Push 間隔"
								value={autoPushInterval}
								min={0}
								max={1440}
								step={1}
								unit="分"
								onChange={setAutoPushInterval}
							/>
							<Toggle
								id="pull-before-push-toggle"
								label="Push 前に Pull"
								checked={pullBeforePush}
								onChange={setPullBeforePush}
							/>
							<SelectInput
								id="sync-method-select"
								label="同期方法"
								value={syncMethod}
								options={syncMethodOptions}
								onChange={setSyncMethod}
							/>
							<TextInput
								id="commit-message-input"
								label="コミットメッセージ"
								value={commitMessage}
								onChange={setCommitMessage}
								disabled={!gitSyncEnabled}
							/>
							<Toggle
								id="auto-pull-on-startup-toggle"
								label="起動時に自動 Pull"
								checked={autoPullOnStartup}
								onChange={setAutoPullOnStartup}
							/>
							{onManualSync && (
								<button
									type="button"
									onClick={onManualSync}
									disabled={!gitSyncEnabled}
									className="w-full rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
								>
									手動同期を実行
								</button>
							)}
						</>
					) : (
						<div className="space-y-3 rounded-md bg-bg-secondary px-4 py-3">
							<p className="text-xs font-medium text-text-primary">
								Git リポジトリが見つかりません
							</p>
							<p className="text-[11px] leading-relaxed text-text-secondary">
								Git 同期を使用するには、ワークスペースを Git リポジトリとして初期化し、GitHub
								リモートを設定してください。
							</p>
							<div className="space-y-1.5 text-[11px] text-text-secondary">
								<p className="font-medium text-text-primary">セットアップ手順:</p>
								<ol className="list-inside list-decimal space-y-1">
									<li>ターミナルでワークスペースを開く</li>
									<li>
										<code className="rounded bg-black/5 px-1 py-0.5 dark:bg-white/10">
											git init
										</code>{" "}
										を実行
									</li>
									<li>GitHub でリポジトリを作成</li>
									<li>
										<code className="rounded bg-black/5 px-1 py-0.5 dark:bg-white/10">
											git remote add origin &lt;URL&gt;
										</code>{" "}
										を実行
									</li>
								</ol>
							</div>
							<p className="text-[11px] text-text-secondary">
								設定完了後、アプリを再起動すると Git 同期の設定が表示されます。
							</p>
						</div>
					))}

				{validSection === "workspace" && workspacePath && (
					<WorkspaceSection
						workspacePath={workspacePath}
						onOpenFile={onOpenFile}
						onClose={onClose}
					/>
				)}

				{validSection === "about" && (
					<div className="space-y-3">
						<div className="rounded-md bg-bg-secondary px-4 py-3">
							<p className="text-xs font-medium text-text-primary">scripta</p>
							<p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
								ローカルファイルベースの軽量 Markdown メモアプリ。
							</p>
						</div>
						<div className="rounded-md bg-bg-secondary px-4 py-3">
							<p className="text-[11px] leading-relaxed text-text-secondary">
								自分が使うために作っています。もし役立ったらコーヒー奢ってください。
							</p>
							<button
								type="button"
								onClick={() => {
									openExternal(KOFI_URL).catch(() => {
										useToastStore.getState().addToast("error", "リンクを開けませんでした");
									});
								}}
								className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#FF5E5B] px-4 py-2 text-xs font-medium text-white transition-opacity hover:opacity-90"
							>
								<Coffee size={14} />
								Ko-fi で応援する
							</button>
						</div>
					</div>
				)}
			</SidebarDialogLayout>
		</DialogBase>
	);
}
