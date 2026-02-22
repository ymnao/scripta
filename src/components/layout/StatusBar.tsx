import { Moon, Sun } from "lucide-react";
import { useThemeStore } from "../../stores/theme";
import type { CursorInfo } from "../editor/MarkdownEditor";

export type SaveStatus = "saved" | "unsaved" | "saving" | "error";

interface StatusBarProps {
	saveStatus?: SaveStatus;
	cursorInfo?: CursorInfo;
}

export function StatusBar({ saveStatus, cursorInfo }: StatusBarProps) {
	const { theme, toggleTheme } = useThemeStore();

	return (
		<div className="flex h-6 items-center justify-between border-t border-border bg-bg-primary px-2 text-text-secondary">
			<output className="text-xs">
				{saveStatus === "unsaved" && "Unsaved"}
				{saveStatus === "saving" && "Saving..."}
				{saveStatus === "saved" && "Saved"}
				{saveStatus === "error" && "Save failed"}
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
					onClick={toggleTheme}
					aria-label="Toggle theme"
					className="flex items-center justify-center rounded p-0.5 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary dark:hover:bg-white/10"
				>
					{theme === "light" ? <Moon size={13} /> : <Sun size={13} />}
				</button>
			</div>
		</div>
	);
}
