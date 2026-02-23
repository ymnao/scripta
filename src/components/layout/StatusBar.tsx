import { CircleHelp, Settings } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { CursorInfo } from "../editor/MarkdownEditor";

export type SaveStatus = "saved" | "unsaved" | "saving" | "error";

interface StatusBarProps {
	saveStatus?: SaveStatus;
	cursorInfo?: CursorInfo;
	filePath?: string;
	onOpenSettings?: () => void;
	onOpenHelp?: () => void;
}

export function StatusBar({
	saveStatus,
	cursorInfo,
	filePath,
	onOpenSettings,
	onOpenHelp,
}: StatusBarProps) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef(0);

	const handleCopyPath = useCallback(() => {
		if (!filePath) return;
		navigator.clipboard.writeText(filePath).then(() => {
			clearTimeout(timerRef.current);
			setCopied(true);
			timerRef.current = window.setTimeout(() => setCopied(false), 1500);
		});
	}, [filePath]);

	return (
		<div className="flex h-6 items-center justify-between border-t border-border bg-bg-primary pl-2 pr-3 text-text-secondary">
			<div className="flex min-w-0 items-center gap-3 text-xs">
				<output className="shrink-0">
					{saveStatus === "unsaved" && "未保存"}
					{saveStatus === "saving" && "保存中..."}
					{saveStatus === "saved" && "保存済み"}
					{saveStatus === "error" && "保存失敗"}
				</output>
				{filePath && (
					<button
						type="button"
						onClick={handleCopyPath}
						className="min-w-0 truncate rounded px-1 hover:bg-black/10 dark:hover:bg-white/10"
						title={filePath}
						data-testid="file-path"
					>
						{copied ? "コピーしました" : filePath}
					</button>
				)}
			</div>
			<div className="flex items-center gap-3 text-xs">
				{cursorInfo && (
					<>
						{cursorInfo.selectedChars != null && cursorInfo.selectedLines != null ? (
							<span data-testid="selection-info">
								{cursorInfo.selectedLines} 行選択, {cursorInfo.selectedChars} 文字選択
							</span>
						) : (
							<span>
								Ln {cursorInfo.line}, Col {cursorInfo.col}
							</span>
						)}
						<span>{cursorInfo.chars} chars</span>
					</>
				)}
				<button
					type="button"
					onClick={onOpenSettings}
					aria-label="Settings"
					title="Settings"
					className="flex items-center justify-center rounded p-0.5 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary dark:hover:bg-white/10"
				>
					<Settings size={15} />
				</button>
				<button
					type="button"
					onClick={onOpenHelp}
					aria-label="Keyboard Shortcuts"
					title="Keyboard Shortcuts"
					className="flex items-center justify-center rounded p-0.5 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary dark:hover:bg-white/10"
				>
					<CircleHelp size={15} />
				</button>
			</div>
		</div>
	);
}
