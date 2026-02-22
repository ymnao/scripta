import { X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { FontFamily, IndentSize, ThemePreference } from "../../lib/store";
import { useSettingsStore } from "../../stores/settings";
import { useThemeStore } from "../../stores/theme";
import { DialogBase } from "./DialogBase";

interface SettingsDialogProps {
	open: boolean;
	onClose: () => void;
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

const indentSizeOptions: { value: IndentSize; label: string }[] = [
	{ value: 2, label: "2" },
	{ value: 4, label: "4" },
];

type Section = "appearance" | "editor" | "save";

const sections: { key: Section; label: string }[] = [
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

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
	const titleId = useId();
	const [activeSection, setActiveSection] = useState<Section>("appearance");
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
	const indentSize = useSettingsStore((s) => s.indentSize);
	const setIndentSize = useSettingsStore((s) => s.setIndentSize);
	const autoSaveDelay = useSettingsStore((s) => s.autoSaveDelay);
	const setAutoSaveDelay = useSettingsStore((s) => s.setAutoSaveDelay);
	const trimTrailingWhitespace = useSettingsStore((s) => s.trimTrailingWhitespace);
	const setTrimTrailingWhitespace = useSettingsStore((s) => s.setTrimTrailingWhitespace);

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
								activeSection === s.key
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
					{activeSection === "appearance" && (
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

					{activeSection === "editor" && (
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
							<SelectInput
								id="indent-size-select"
								label="インデントサイズ"
								value={indentSize}
								options={indentSizeOptions}
								onChange={setIndentSize}
							/>
						</>
					)}

					{activeSection === "save" && (
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
				</div>
			</div>
		</DialogBase>
	);
}
