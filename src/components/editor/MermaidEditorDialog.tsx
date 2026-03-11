import { useCallback, useEffect, useRef, useState } from "react";
import { renderMermaid } from "../../lib/mermaid";
import { useThemeStore } from "../../stores/theme";
import { DialogBase } from "../common/DialogBase";

interface MermaidEditorDialogProps {
	open: boolean;
	source: string;
	mode?: "edit" | "insert";
	onSave: (newSource: string) => void;
	onCancel: () => void;
}

export function MermaidEditorDialog({
	open,
	source,
	mode = "edit",
	onSave,
	onCancel,
}: MermaidEditorDialogProps) {
	const [code, setCode] = useState(source);
	const [preview, setPreview] = useState<{ svg?: string; error?: string }>({});
	const theme = useThemeStore((s) => s.theme);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const renderGenRef = useRef(0);

	useEffect(() => {
		if (open) setCode(source);
	}, [open, source]);

	useEffect(() => {
		if (open) {
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (el) {
					el.focus();
					el.setSelectionRange(el.value.length, el.value.length);
				}
			});
		}
	}, [open]);

	useEffect(() => {
		// 閉じた時点で世代を進め、未完了の promise の結果を無効化する
		if (!open || !code.trim()) {
			++renderGenRef.current;
			setPreview({});
			return;
		}
		const gen = ++renderGenRef.current;
		const timer = setTimeout(() => {
			renderMermaid(code.trim(), theme)
				.then((svg) => {
					if (gen === renderGenRef.current) setPreview({ svg });
				})
				.catch((e) => {
					if (gen === renderGenRef.current)
						setPreview({ error: e instanceof Error ? e.message : String(e) });
				});
		}, 300);
		return () => clearTimeout(timer);
	}, [code, theme, open]);

	const handleSave = useCallback(() => {
		onSave(code);
	}, [code, onSave]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				handleSave();
			}
		},
		[handleSave],
	);

	return (
		<DialogBase open={open} onClose={onCancel} className="max-w-4xl">
			<div className="flex flex-col gap-3">
				<h2 className="text-sm font-semibold text-text-primary">Mermaid エディタ</h2>
				<div className="flex gap-3" style={{ height: "60vh" }}>
					<div className="flex flex-1 flex-col">
						<textarea
							ref={textareaRef}
							value={code}
							onChange={(e) => setCode(e.target.value)}
							onKeyDown={handleKeyDown}
							className="h-full w-full resize-none rounded-md border border-border bg-bg-secondary p-3 font-mono text-sm text-text-primary outline-none focus:ring-1 focus:ring-blue-500"
							spellCheck={false}
						/>
					</div>
					<div className="flex flex-1 items-start justify-center overflow-auto rounded-md border border-border p-4">
						{preview.svg ? (
							<div
								className="w-full [&_svg]:mx-auto [&_svg]:block"
								// biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid SVG output with securityLevel: 'strict'
								dangerouslySetInnerHTML={{ __html: preview.svg }}
							/>
						) : preview.error ? (
							<div className="whitespace-pre-wrap font-mono text-xs text-red-500">
								{preview.error}
							</div>
						) : (
							<div className="text-sm text-text-secondary">
								{code.trim()
									? "レンダリング中..."
									: "左のエディタに Mermaid コードを入力してください"}
							</div>
						)}
					</div>
				</div>
				<div className="flex justify-end gap-2">
					<button
						type="button"
						className="rounded px-3 py-1.5 text-sm text-text-secondary hover:bg-black/5 dark:hover:bg-white/5"
						onClick={onCancel}
					>
						キャンセル
					</button>
					<button
						type="button"
						className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
						onClick={handleSave}
					>
						{mode === "insert" ? "挿入" : "保存"}
					</button>
				</div>
			</div>
		</DialogBase>
	);
}
