import { X } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { translateError } from "../../lib/errors";
import {
	type ExportTheme,
	type PageBreakLevel,
	exportAsHtml,
	exportAsPdf,
	exportAsPrompt,
	getDefaultPromptTemplate,
} from "../../lib/export";
import {
	getScriptaPromptTemplatePath,
	loadPromptTemplate,
	savePromptTemplate,
} from "../../lib/scripta-config";
import { useToastStore } from "../../stores/toast";
import { DialogBase } from "./DialogBase";
import { RangeInput, SelectInput, Toggle } from "./FormInputs";
import { SidebarDialogLayout } from "./SidebarDialogLayout";

const isPdfSupported =
	typeof navigator !== "undefined" && /mac|win/i.test(navigator.userAgent ?? "");

interface ExportDialogProps {
	open: boolean;
	onClose: () => void;
	markdown: string;
	filePath: string;
	workspacePath?: string | null;
	onOpenFile?: (path: string) => void;
	scriptaDirReady?: boolean;
	onScriptaDirConfirm?: () => void;
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

export function ExportDialog({
	open,
	onClose,
	markdown,
	filePath,
	workspacePath,
	onOpenFile,
	scriptaDirReady,
	onScriptaDirConfirm,
}: ExportDialogProps) {
	const titleId = useId();
	const [activeSection, setActiveSection] = useState<Section>("html");
	const [htmlTheme, setHtmlTheme] = useState<ExportTheme>("system");
	const [pageBreakEnabled, setPageBreakEnabled] = useState(true);
	const [pageBreakLevel, setPageBreakLevel] = useState<Exclude<PageBreakLevel, "none">>("h3");
	const [smartPageBreak, setSmartPageBreak] = useState(true);
	const [forceUpperBreak, setForceUpperBreak] = useState(true);
	const [pdfZoom, setPdfZoom] = useState(100);
	const [exporting, setExporting] = useState(false);
	const [showScriptaDirConfirm, setShowScriptaDirConfirm] = useState(false);

	useEffect(() => {
		if (!open) setShowScriptaDirConfirm(false);
	}, [open]);

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
			let customTemplate: string | null = null;
			if (workspacePath) {
				customTemplate = await loadPromptTemplate(workspacePath);
			}
			const result = await exportAsPrompt(markdown, filePath, customTemplate);
			if (result) onClose();
		} catch (err: unknown) {
			useToastStore
				.getState()
				.addToast("error", `プロンプトエクスポートに失敗しました: ${translateError(err)}`);
		} finally {
			setExporting(false);
		}
	};

	const handleCustomizeTemplate = async () => {
		if (!workspacePath || !onOpenFile) return;
		try {
			const templatePath = getScriptaPromptTemplatePath(workspacePath);
			const existing = await loadPromptTemplate(workspacePath);

			if (existing === null) {
				if (!scriptaDirReady && !showScriptaDirConfirm) {
					setShowScriptaDirConfirm(true);
					return;
				}
				await savePromptTemplate(workspacePath, getDefaultPromptTemplate());
			}
			onScriptaDirConfirm?.();
			setShowScriptaDirConfirm(false);
			onClose();
			onOpenFile(templatePath);
		} catch (err: unknown) {
			setShowScriptaDirConfirm(false);
			useToastStore
				.getState()
				.addToast("error", `テンプレートの作成に失敗しました: ${translateError(err)}`);
		}
	};

	return (
		<DialogBase open={open} onClose={onClose} ariaLabelledBy={titleId} size="lg" fixedHeight>
			<div className="flex shrink-0 items-center justify-between">
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

			<SidebarDialogLayout
				sections={sections}
				activeSection={activeSection}
				onSectionChange={(key) => setActiveSection(key as Section)}
				navAriaLabel="エクスポートセクション"
			>
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
						<Toggle
							id="export-pdf-page-break"
							label="見出しで改ページ"
							checked={pageBreakEnabled}
							onChange={setPageBreakEnabled}
							size="sm"
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
								<Toggle
									id="export-pdf-smart-page-break"
									label="不要な改ページを抑制"
									checked={smartPageBreak}
									onChange={setSmartPageBreak}
									size="sm"
								/>
								{smartPageBreak && pageBreakLevel !== "h1" && (
									<Toggle
										id="export-pdf-force-upper-break"
										label="上位見出しは常に改ページ"
										checked={forceUpperBreak}
										onChange={setForceUpperBreak}
										size="sm"
									/>
								)}
							</>
						)}
						<RangeInput
							id="export-pdf-zoom"
							label="縮尺"
							value={pdfZoom}
							min={25}
							max={200}
							step={5}
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
						{workspacePath && onOpenFile && (
							<>
								<button
									type="button"
									onClick={handleCustomizeTemplate}
									className="text-[11px] text-blue-600 hover:underline dark:text-blue-400"
								>
									テンプレートをカスタマイズ
								</button>
								{showScriptaDirConfirm && (
									<div className="rounded-md border border-border bg-bg-secondary p-2">
										<p className="text-[11px] text-text-secondary">
											テンプレートを保存するため .scripta/ フォルダを作成します。続行しますか？
										</p>
										<div className="mt-1.5 flex gap-2">
											<button
												type="button"
												onClick={handleCustomizeTemplate}
												className="rounded bg-blue-600 px-2 py-0.5 text-[11px] text-white hover:bg-blue-700"
											>
												作成
											</button>
											<button
												type="button"
												onClick={() => setShowScriptaDirConfirm(false)}
												className="rounded bg-bg-primary px-2 py-0.5 text-[11px] text-text-secondary hover:bg-black/5 dark:hover:bg-white/5"
											>
												キャンセル
											</button>
										</div>
									</div>
								)}
							</>
						)}
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
			</SidebarDialogLayout>
		</DialogBase>
	);
}
