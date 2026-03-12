import { ExternalLink, Plus, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { writeFile } from "../../lib/commands";
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
} from "../../lib/scripta-config";
import type { FontFamily, ThemePreference } from "../../lib/store";
import { useSettingsStore } from "../../stores/settings";
import { useThemeStore } from "../../stores/theme";
import { useToastStore } from "../../stores/toast";
import { useWorkspaceStore } from "../../stores/workspace";
import { DialogBase } from "./DialogBase";

interface SettingsDialogProps {
	open: boolean;
	onClose: () => void;
	workspacePath?: string | null;
	onOpenFile?: (path: string) => void;
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

type Section = "appearance" | "editor" | "save" | "workspace";

const baseSections: { key: Section; label: string }[] = [
	{ key: "appearance", label: "外観" },
	{ key: "editor", label: "エディタ" },
	{ key: "save", label: "保存" },
];

function Toggle({
	id,
	label,
	checked,
	onChange,
}: { id: string; label: string; checked: boolean; onChange: (value: boolean) => void }) {
	return (
		<div className="flex items-center justify-between rounded-md bg-bg-secondary px-3 py-2">
			<label htmlFor={id} className="text-xs font-medium text-text-primary">
				{label}
			</label>
			<button
				id={id}
				type="button"
				role="switch"
				aria-checked={checked}
				className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
					checked ? "bg-blue-600" : "bg-black/20 dark:bg-white/20"
				}`}
				onClick={() => onChange(!checked)}
			>
				<span
					className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
						checked ? "translate-x-4" : "translate-x-0"
					}`}
				/>
			</button>
		</div>
	);
}

function NumberInput({
	id,
	label,
	value,
	min,
	max,
	step,
	unit,
	onChange,
}: {
	id: string;
	label: string;
	value: number;
	min: number;
	max: number;
	step: number;
	unit: string;
	onChange: (value: number) => void;
}) {
	const [draft, setDraft] = useState(String(value));

	// Sync draft when the external value changes (e.g. from another source)
	useEffect(() => {
		setDraft(String(value));
	}, [value]);

	const commit = () => {
		const num = Number(draft);
		if (!Number.isNaN(num)) {
			const clamped = Math.min(max, Math.max(min, num));
			onChange(clamped);
			setDraft(String(clamped));
		} else {
			// Invalid input — revert to current value
			setDraft(String(value));
		}
	};

	return (
		<div className="flex items-center justify-between rounded-md bg-bg-secondary px-3 py-2">
			<label htmlFor={id} className="text-xs font-medium text-text-primary">
				{label}
			</label>
			<div className="flex items-center gap-1.5">
				<input
					id={id}
					type="number"
					min={min}
					max={max}
					step={step}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={commit}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.currentTarget.blur();
						}
					}}
					className="w-16 rounded border border-border bg-bg-primary px-2 py-0.5 text-right text-xs text-text-primary outline-none focus:border-blue-500"
				/>
				<span className="text-[10px] text-text-secondary">{unit}</span>
			</div>
		</div>
	);
}

function SelectInput<T extends string | number>({
	id,
	label,
	value,
	options,
	onChange,
}: {
	id: string;
	label: string;
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
}) {
	return (
		<div className="flex items-center justify-between rounded-md bg-bg-secondary px-3 py-2">
			<label htmlFor={id} className="text-xs font-medium text-text-primary">
				{label}
			</label>
			<select
				id={id}
				value={String(value)}
				onChange={(e) => {
					const raw = e.target.value;
					const match = options.find((o) => String(o.value) === raw);
					if (match) onChange(match.value);
				}}
				className="rounded border border-border bg-bg-primary px-2 py-0.5 text-xs text-text-primary outline-none focus:border-blue-500"
			>
				{options.map((opt) => (
					<option key={String(opt.value)} value={String(opt.value)}>
						{opt.label}
					</option>
				))}
			</select>
		</div>
	);
}

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
	const addToast = useToastStore.getState().addToast;
	const bumpFileTreeVersion = useWorkspaceStore.getState().bumpFileTreeVersion;

	useEffect(() => {
		let cancelled = false;

		(async () => {
			const templates = [
				{
					name: "README.md",
					path: getReadmeTemplatePath(workspacePath),
					getContent: () => README_TEMPLATE,
				},
				{
					name: "CLAUDE.md",
					path: getClaudeMdTemplatePath(workspacePath),
					getContent: () => CLAUDE_MD_TEMPLATE,
				},
				{
					name: ".gitignore",
					path: getGitignorePath(workspacePath),
					getContent: () => GITIGNORE_TEMPLATE,
				},
				{
					name: "syntax-guide.md",
					path: getSyntaxGuidePath(workspacePath),
					getContent: () => SYNTAX_GUIDE_TEMPLATE,
				},
				{
					name: "prompt-template.md",
					path: getScriptaPromptTemplatePath(workspacePath),
					getContent: () => getDefaultPromptTemplate(),
				},
			];

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
			try {
				// 書き込み直前に再確認し、外部で作成された場合の上書きを防ぐ
				if (await fileExists(file.path)) {
					setFiles((prev) => prev.map((f) => (f.path === file.path ? { ...f, exists: true } : f)));
					return;
				}

				// writeFile は Rust 側で親ディレクトリを自動作成する（create_dir_all）
				await writeFile(file.path, file.getContent());
				setFiles((prev) => prev.map((f) => (f.path === file.path ? { ...f, exists: true } : f)));
				bumpFileTreeVersion();
			} catch (err) {
				addToast(
					"error",
					`ファイルの作成に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
		[addToast, bumpFileTreeVersion],
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
							className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/30"
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

export function SettingsDialog({ open, onClose, workspacePath, onOpenFile }: SettingsDialogProps) {
	const titleId = useId();
	const sections = workspacePath
		? [...baseSections, { key: "workspace" as Section, label: "ワークスペース" }]
		: baseSections;
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

	return (
		<DialogBase open={open} onClose={onClose} ariaLabelledBy={titleId} className="max-w-lg">
			<div className="flex items-center justify-between">
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

			<div className="mt-4 flex gap-4">
				{/* 左カラム: ナビゲーション */}
				<nav className="w-24 shrink-0 space-y-0.5" aria-label="設定セクション">
					{sections.map((s) => (
						<button
							key={s.key}
							type="button"
							onClick={() => setActiveSection(s.key)}
							className={`w-full rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
								validSection === s.key
									? "bg-blue-600 text-white"
									: "text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
							}`}
						>
							{s.label}
						</button>
					))}
				</nav>

				{/* 右カラム: 設定内容 */}
				<div className="min-h-[10rem] min-w-0 flex-1 space-y-2">
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

					{validSection === "workspace" && workspacePath && (
						<WorkspaceSection
							workspacePath={workspacePath}
							onOpenFile={onOpenFile}
							onClose={onClose}
						/>
					)}
				</div>
			</div>
		</DialogBase>
	);
}
