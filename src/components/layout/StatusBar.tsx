import { CircleHelp, Settings } from "lucide-react";
import type { CursorInfo } from "../editor/MarkdownEditor";

export type SaveStatus = "saved" | "unsaved" | "saving" | "error";

interface StatusBarProps {
	saveStatus?: SaveStatus;
	cursorInfo?: CursorInfo;
	onOpenSettings?: () => void;
	onOpenHelp?: () => void;
}

export function StatusBar({ saveStatus, cursorInfo, onOpenSettings, onOpenHelp }: StatusBarProps) {
	return (
		<div className="flex h-6 items-center justify-between border-t border-border bg-bg-primary pl-2 pr-3 text-text-secondary">
			<output className="text-xs">
				{saveStatus === "unsaved" && "未保存"}
				{saveStatus === "saving" && "保存中..."}
				{saveStatus === "saved" && "保存済み"}
				{saveStatus === "error" && "保存失敗"}
			</output>
			<div className="flex items-center gap-3 text-xs">
				{cursorInfo && (
					<>
						<span>
							Ln {cursorInfo.line}, Col {cursorInfo.col}
						</span>
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
