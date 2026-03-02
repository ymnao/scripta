import { X } from "lucide-react";
import { useId, useState } from "react";
import { type ExportTheme, exportAsHtml, exportAsPrompt } from "../../lib/export";
import { useToastStore } from "../../stores/toast";
import { DialogBase } from "./DialogBase";

interface ExportDialogProps {
	open: boolean;
	onClose: () => void;
	markdown: string;
	filePath: string;
}

type Section = "html" | "prompt";

const sections: { key: Section; label: string }[] = [
	{ key: "html", label: "HTML" },
	{ key: "prompt", label: "プロンプト" },
];

const htmlThemeOptions: { value: ExportTheme; label: string }[] = [
	{ value: "system", label: "システム" },
	{ value: "light", label: "ライト" },
	{ value: "dark", label: "ダーク" },
];

export function ExportDialog({ open, onClose, markdown, filePath }: ExportDialogProps) {
	const titleId = useId();
	const [activeSection, setActiveSection] = useState<Section>("html");
	const [htmlTheme, setHtmlTheme] = useState<ExportTheme>("system");
	const [exporting, setExporting] = useState(false);

	const handleExportHtml = async () => {
		setExporting(true);
		try {
			const result = await exportAsHtml(markdown, filePath, { theme: htmlTheme });
			if (result) onClose();
		} catch (err: unknown) {
			useToastStore.getState().addToast("error", `HTMLエクスポートに失敗しました: ${err}`);
		} finally {
			setExporting(false);
		}
	};

	const handleExportPrompt = async () => {
		setExporting(true);
		try {
			const result = await exportAsPrompt(markdown, filePath);
			if (result) onClose();
		} catch (err: unknown) {
			useToastStore.getState().addToast("error", `プロンプトエクスポートに失敗しました: ${err}`);
		} finally {
			setExporting(false);
		}
	};

	return (
		<DialogBase open={open} onClose={onClose} ariaLabelledBy={titleId} className="max-w-lg">
			<div className="flex items-center justify-between">
				<h2 id={titleId} className="text-sm font-semibold text-text-primary">
					エクスポート
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
				<nav className="w-24 shrink-0 space-y-0.5" aria-label="エクスポートセクション">
					{sections.map((s) => (
						<button
							key={s.key}
							type="button"
							onClick={() => setActiveSection(s.key)}
							className={`w-full rounded-md px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
								activeSection === s.key
									? "bg-blue-600 text-white"
									: "text-text-secondary hover:bg-bg-secondary hover:text-text-primary"
							}`}
						>
							{s.label}
						</button>
					))}
				</nav>

				<div className="min-h-[10rem] min-w-0 flex-1 space-y-3">
					{activeSection === "html" && (
						<>
							<SelectInput
								id="export-html-theme"
								label="テーマ"
								value={htmlTheme}
								options={htmlThemeOptions}
								onChange={setHtmlTheme}
							/>
							<p className="text-[11px] leading-relaxed text-text-secondary">
								Markdownを完全なHTMLドキュメントに変換します。KaTeX数式・GFMテーブル対応。
							</p>
							<div className="flex justify-end">
								<button
									type="button"
									disabled={exporting}
									onClick={handleExportHtml}
									className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
								>
									HTMLとしてエクスポート
								</button>
							</div>
						</>
					)}

					{activeSection === "prompt" && (
						<>
							<p className="text-[11px] leading-relaxed text-text-secondary">
								生成AIにMarkdownを渡してリッチHTMLを生成するためのプロンプトファイルを書き出します。
							</p>
							<div className="flex justify-end">
								<button
									type="button"
									disabled={exporting}
									onClick={handleExportPrompt}
									className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
								>
									プロンプトをエクスポート
								</button>
							</div>
						</>
					)}
				</div>
			</div>
		</DialogBase>
	);
}

function SelectInput<T extends string>({
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
				value={value}
				onChange={(e) => {
					const match = options.find((o) => o.value === e.target.value);
					if (match) onChange(match.value);
				}}
				className="rounded border border-border bg-bg-primary px-2 py-0.5 text-xs text-text-primary outline-none focus:border-blue-500"
			>
				{options.map((opt) => (
					<option key={opt.value} value={opt.value}>
						{opt.label}
					</option>
				))}
			</select>
		</div>
	);
}
