import { Moon, Sun } from "lucide-react";
import { useThemeStore } from "../../stores/theme";

export function StatusBar() {
	const { theme, toggleTheme } = useThemeStore();

	return (
		<div className="flex h-6 items-center justify-end border-t border-border bg-bg-primary px-2 text-text-secondary">
			<button
				type="button"
				onClick={toggleTheme}
				className="flex items-center justify-center rounded p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
			>
				{theme === "light" ? <Moon size={13} /> : <Sun size={13} />}
			</button>
		</div>
	);
}
