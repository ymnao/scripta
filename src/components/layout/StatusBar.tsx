import { Moon, Sun } from "lucide-react";
import { useThemeStore } from "../../stores/theme";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

interface StatusBarProps {
	saveStatus?: SaveStatus;
}

export function StatusBar({ saveStatus = "idle" }: StatusBarProps) {
	const { theme, toggleTheme } = useThemeStore();

	return (
		<div className="flex h-6 items-center justify-between border-t border-border bg-bg-primary px-2 text-text-secondary">
			<div className="text-xs">
				{saveStatus === "saving" && "Saving..."}
				{saveStatus === "saved" && "Saved"}
				{saveStatus === "error" && "Save failed"}
			</div>
			<button
				type="button"
				onClick={toggleTheme}
				aria-label="Toggle theme"
				className="flex items-center justify-center rounded p-0.5 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary dark:hover:bg-white/10"
			>
				{theme === "light" ? <Moon size={13} /> : <Sun size={13} />}
			</button>
		</div>
	);
}
