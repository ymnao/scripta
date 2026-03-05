import { X } from "lucide-react";
import { useId, useState } from "react";
import { translateError } from "../../lib/errors";
import {
	type ExportTheme,
	type PageBreakLevel,
	exportAsHtml,
	exportAsPdf,
	exportAsPrompt,
} from "../../lib/export";
import { useToastStore } from "../../stores/toast";
import { DialogBase } from "./DialogBase";

const isPdfSupported =
	typeof navigator !== "undefined" &&
	/mac|win/i.test(navigator.userAgentData?.platform ?? navigator.platform ?? "");

interface ExportDialogProps {
	open: boolean;
	onClose: () => void;
	markdown: string;
	filePath: string;
}

type Section = "html" | "pdf" | "prompt";

const sections: { key: Section; label: string }[] = [
	{ key: "html", label: "HTML" },
	{ key: "pdf", label: "PDF" },
	{ key: "prompt", label: "プロンプト" },
];

const htmlThemeOptions: { value: ExportTheme; label: string }[] = [
	{ value: "system", label: "システム" },
	{ value: "light", label: "ライト" },
	{ value: "dark", label: "ダーク" },
];

const pageBreakLevelOptions: { value: Exclude<PageBreakLevel, "none">; label: string }[] = [
	{ value: "h1", label: "h1のみ" },
	{ value: "h2", label: "h2まで" },
	{ value: "h3", label: "h3まで" },
];

export function ExportDialog({ open, onClose, markdown, filePath }: ExportDialogProps) {
	const titleId = useId();
	const [activeSection, setActiveSection] = useState<Section>("html");
	const [htmlTheme, setHtmlTheme] = useState<ExportTheme>("system");
	const [pageBreakEnabled, setPageBreakEnabled] = useState(true);
	const [pageBreakLevel, setPageBreakLevel] = useState<Exclude<PageBreakLevel, "none">>("h3");
	const [smartPageBreak, setSmartPageBreak] = useState(true);
	const [forceUpperBreak, setForceUpperBreak] = useState(true);
	const [pdfZoom, setPdfZoom] = useState(100);
	const [exporting, setExporting] = useState(false);

	const handleExportHtml = async () => {
		setExporting(true);
		try {
			const result = await exportAsHtml(markdown, filePath, { theme: htmlTheme });
			if (result) onClose();
		} catch (err: unknown) {
			useToastStore
				.getState()
				.addToast("error", `HTMLエクスポートに失敗しました: ${translateError(err)}`);
		} finally {
			setExporting(false);
		}
	};

	const handleExportPdf = async () => {
		setExporting(true);
		try {
			const result = await exportAsPdf(markdown, filePath, {
				pageBreakLevel: pageBreakEnabled ? pageBreakLevel : "none",
				smartPageBreak,
				forceUpperBreak,
				zoom: pdfZoom,
			});
			if (result) onClose();
		} catch (err: unknown) {
			useToastStore
				.getState()
				.addToast("error", `PDFエクスポートに失敗しました: ${translateError(err)}`);
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
			useToastStore
				.getState()
				.addToast("error", `プロンプトエクスポートに失敗しました: ${translateError(err)}`);
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
					aria-label="閉じる"
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
									{exporting ? "エクスポート中..." : "HTMLとしてエクスポート"}
								</button>
							</div>
						</>
					)}

					{activeSection === "pdf" && (
						<>
							<ToggleInput
								id="export-pdf-page-break"
								label="見出しで改ページ"
								checked={pageBreakEnabled}
								onChange={setPageBreakEnabled}
							/>
							{pageBreakEnabled && (
								<>
									<SelectInput
										id="export-pdf-page-break-level"
										label="対象レベル"
										value={pageBreakLevel}
										options={pageBreakLevelOptions}
										onChange={setPageBreakLevel}
									/>
									<ToggleInput
										id="export-pdf-smart-page-break"
										label="不要な改ページを抑制"
										checked={smartPageBreak}
										onChange={setSmartPageBreak}
									/>
									{smartPageBreak && pageBreakLevel !== "h1" && (
										<ToggleInput
											id="export-pdf-force-upper-break"
											label="上位見出しは常に改ページ"
											checked={forceUpperBreak}
											onChange={setForceUpperBreak}
										/>
									)}
								</>
							)}
							<RangeInput
								id="export-pdf-zoom"
								label="縮尺"
								value={pdfZoom}
								min={50}
								max={150}
								step={10}
								unit="%"
								onChange={setPdfZoom}
							/>
							<p className="text-[11px] leading-relaxed text-text-secondary">
								MarkdownをPDFファイルとして書き出します。
								{!isPdfSupported && " macOS・Windowsのみ対応。"}
							</p>
							<div className="flex justify-end">
								<button
									type="button"
									disabled={exporting || !isPdfSupported}
									onClick={handleExportPdf}
									className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
								>
									{exporting ? "エクスポート中..." : "PDFとしてエクスポート"}
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
									{exporting ? "エクスポート中..." : "プロンプトをエクスポート"}
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

function RangeInput({
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
	return (
		<div className="flex items-center justify-between gap-3 rounded-md bg-bg-secondary px-3 py-2">
			<label htmlFor={id} className="shrink-0 text-xs font-medium text-text-primary">
				{label}
			</label>
			<div className="flex items-center gap-2">
				<input
					id={id}
					type="range"
					min={min}
					max={max}
					step={step}
					value={value}
					onChange={(e) => onChange(Number(e.target.value))}
					className="h-1 w-20 cursor-pointer accent-blue-600"
				/>
				<span className="w-10 text-right text-xs tabular-nums text-text-secondary">
					{value}
					{unit}
				</span>
			</div>
		</div>
	);
}

function ToggleInput({
	id,
	label,
	checked,
	onChange,
}: {
	id: string;
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-center justify-between rounded-md bg-bg-secondary px-3 py-2">
			<span id={`${id}-label`} className="text-xs font-medium text-text-primary">
				{label}
			</span>
			<button
				id={id}
				type="button"
				role="switch"
				aria-checked={checked}
				aria-labelledby={`${id}-label`}
				onClick={() => onChange(!checked)}
				className={`relative h-4 w-7 rounded-full transition-colors ${checked ? "bg-blue-600" : "bg-black/20 dark:bg-white/20"}`}
			>
				<span
					className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white transition-transform ${checked ? "translate-x-3" : ""}`}
				/>
			</button>
		</div>
	);
}
