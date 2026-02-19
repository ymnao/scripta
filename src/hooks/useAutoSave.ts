import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveStatus } from "../components/layout/StatusBar";
import { writeFile } from "../lib/commands";

const DEBOUNCE_MS = 2000;

interface UseAutoSaveReturn {
	saveStatus: SaveStatus;
	saveNow: () => void;
	markSaved: (content: string) => void;
}

export function useAutoSave(filePath: string, content: string): UseAutoSaveReturn {
	const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
	const contentRef = useRef(content);
	contentRef.current = content;
	const lastSavedContentRef = useRef(content);
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isMountedRef = useRef(true);
	const saveIdRef = useRef(0);
	const prevFilePathRef = useRef(filePath);
	const awaitingNewFileRef = useRef(false);

	const save = useCallback(
		(contentToSave: string) => {
			if (contentToSave === lastSavedContentRef.current) {
				return;
			}
			saveIdRef.current += 1;
			const currentSaveId = saveIdRef.current;
			setSaveStatus("saving");
			writeFile(filePath, contentToSave)
				.then(() => {
					if (!isMountedRef.current) return;
					if (currentSaveId !== saveIdRef.current) return;
					lastSavedContentRef.current = contentToSave;
					setSaveStatus("saved");
				})
				.catch((err) => {
					if (!isMountedRef.current) return;
					if (currentSaveId !== saveIdRef.current) return;
					console.error("Failed to save file:", err);
					setSaveStatus("error");
				});
		},
		[filePath],
	);

	// Flush pending changes to the OLD path when filePath changes
	useEffect(() => {
		if (filePath === prevFilePathRef.current) return;

		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}

		const prevPath = prevFilePathRef.current;
		const currentContent = contentRef.current;
		const hadUnsavedChanges = prevPath && currentContent !== lastSavedContentRef.current;
		prevFilePathRef.current = filePath;
		// Suppress content effect until markSaved is called with the new file's content.
		// This prevents saving stale content from the old file to the new path.
		awaitingNewFileRef.current = true;

		if (hadUnsavedChanges) {
			saveIdRef.current += 1;
			const flushSaveId = saveIdRef.current;
			setSaveStatus("saving");
			writeFile(prevPath, currentContent)
				.then(() => {
					if (!isMountedRef.current) return;
					if (flushSaveId !== saveIdRef.current) return;
					setSaveStatus("saved");
				})
				.catch((err) => {
					if (!isMountedRef.current) return;
					if (flushSaveId !== saveIdRef.current) return;
					console.error("Failed to save previous file:", err);
					setSaveStatus("error");
				});
		}
	}, [filePath]);

	useEffect(() => {
		if (awaitingNewFileRef.current) {
			return;
		}
		if (content === lastSavedContentRef.current) {
			return;
		}
		setSaveStatus("unsaved");
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
		}
		debounceTimerRef.current = setTimeout(() => {
			save(content);
		}, DEBOUNCE_MS);
		return () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
		};
	}, [content, save]);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
		};
	}, []);

	const saveNow = useCallback(() => {
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}
		save(contentRef.current);
	}, [save]);

	const markSaved = useCallback((savedContent: string) => {
		lastSavedContentRef.current = savedContent;
		awaitingNewFileRef.current = false;
		setSaveStatus("saved");
	}, []);

	return { saveStatus, saveNow, markSaved };
}
