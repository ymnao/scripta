import { useCallback, useEffect, useRef } from "react";
import { readFile, writeFile } from "../lib/commands";
import { getScratchpadArchivePath, getScratchpadPath } from "../lib/scripta-config";
import { useSettingsStore } from "../stores/settings";

const LAST_ACTIVE_KEY = "scratchpad-last-active-date";

function todayString(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function useScratchpadVolatile(workspacePath: string | null) {
	const processedRef = useRef(false);

	const archive = useCallback(async () => {
		if (!workspacePath) return;

		const volatile = useSettingsStore.getState().scratchpadVolatile;
		if (!volatile) return;

		const today = todayString();
		const lastDate = localStorage.getItem(LAST_ACTIVE_KEY);

		if (lastDate === today) return;

		// Date changed — archive old content
		const scratchpadPath = getScratchpadPath(workspacePath);

		try {
			const content = await readFile(scratchpadPath);
			const trimmed = content.trim();

			if (trimmed.length > 0 && lastDate) {
				// Archive to date file
				const archivePath = getScratchpadArchivePath(workspacePath, lastDate);
				let existing = "";
				try {
					existing = await readFile(archivePath);
				} catch {
					// File doesn't exist yet
				}

				const archiveContent = existing ? `${existing}\n\n---\n\n${trimmed}` : trimmed;

				await writeFile(archivePath, archiveContent);
			}

			if (trimmed.length > 0) {
				// Clear scratchpad
				await writeFile(scratchpadPath, "");
			}
		} catch {
			// Scratchpad file doesn't exist — nothing to archive
		}

		localStorage.setItem(LAST_ACTIVE_KEY, today);
	}, [workspacePath]);

	// Run on mount
	useEffect(() => {
		if (processedRef.current) return;
		processedRef.current = true;
		void archive();
	}, [archive]);

	// Run on visibility change (foreground restore)
	useEffect(() => {
		const handler = () => {
			if (document.visibilityState === "visible") {
				void archive();
			}
		};
		document.addEventListener("visibilitychange", handler);
		return () => document.removeEventListener("visibilitychange", handler);
	}, [archive]);
}
