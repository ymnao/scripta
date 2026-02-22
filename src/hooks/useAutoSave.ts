import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveStatus } from "../components/layout/StatusBar";
import { writeFile } from "../lib/commands";
import { useSettingsStore } from "../stores/settings";

function processContent(content: string, trimWhitespace: boolean): string {
	let result = content;
	if (trimWhitespace) {
		result = result.replace(/[ \t]+$/gm, "");
	}
	// 最終行末尾改行は常に保証
	if (result.length === 0 || !result.endsWith("\n")) {
		result += "\n";
	}
	return result;
}

interface UseAutoSaveReturn {
	saveStatus: SaveStatus;
	saveNow: () => Promise<boolean>;
	markSaved: (content: string) => void;
	waitForPending: () => Promise<void>;
}

export function useAutoSave(filePath: string, content: string): UseAutoSaveReturn {
	const autoSaveDelay = useSettingsStore((s) => s.autoSaveDelay);
	const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
	const contentRef = useRef(content);
	contentRef.current = content;
	const lastSavedContentRef = useRef(
		processContent(content, useSettingsStore.getState().trimTrailingWhitespace),
	);
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isMountedRef = useRef(true);
	const saveIdRef = useRef(0);
	const prevFilePathRef = useRef(filePath);
	const awaitingNewFileRef = useRef(false);
	const inflightRef = useRef<Promise<void>>(Promise.resolve());

	const save = useCallback(
		(contentToSave: string): Promise<void> => {
			const { trimTrailingWhitespace } = useSettingsStore.getState();
			const processed = processContent(contentToSave, trimTrailingWhitespace);
			if (processed === lastSavedContentRef.current) {
				return Promise.resolve();
			}
			saveIdRef.current += 1;
			const currentSaveId = saveIdRef.current;
			setSaveStatus("saving");
			const writePromise = inflightRef.current.then(() => writeFile(filePath, processed));
			inflightRef.current = writePromise.catch(() => {});
			return writePromise.then(
				() => {
					if (!isMountedRef.current) return;
					if (currentSaveId !== saveIdRef.current) return;
					lastSavedContentRef.current = processed;
					setSaveStatus("saved");
				},
				(err) => {
					if (isMountedRef.current && currentSaveId === saveIdRef.current) {
						console.error("Failed to save file:", err);
						setSaveStatus("error");
					}
					throw err;
				},
			);
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
		const { trimTrailingWhitespace } = useSettingsStore.getState();
		const processed = processContent(currentContent, trimTrailingWhitespace);
		const hadUnsavedChanges = prevPath && processed !== lastSavedContentRef.current;
		prevFilePathRef.current = filePath;
		// Suppress content effect until markSaved is called with the new file's content.
		// This prevents saving stale content from the old file to the new path.
		awaitingNewFileRef.current = true;

		if (hadUnsavedChanges) {
			saveIdRef.current += 1;
			const flushSaveId = saveIdRef.current;
			setSaveStatus("saving");
			const flushPromise = inflightRef.current.then(() => writeFile(prevPath, processed));
			inflightRef.current = flushPromise.catch(() => {});
			flushPromise
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
		const { trimTrailingWhitespace } = useSettingsStore.getState();
		if (processContent(content, trimTrailingWhitespace) === lastSavedContentRef.current) {
			return;
		}
		setSaveStatus("unsaved");
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
		}
		debounceTimerRef.current = setTimeout(() => {
			save(content).catch(() => {});
		}, autoSaveDelay);
		return () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
		};
	}, [content, save, autoSaveDelay]);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
		};
	}, []);

	const saveNow = useCallback((): Promise<boolean> => {
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}
		return save(contentRef.current).then(
			() => true,
			() => false,
		);
	}, [save]);

	const markSaved = useCallback((savedContent: string) => {
		// Normalize to match the format written to disk for consistent comparison
		const { trimTrailingWhitespace } = useSettingsStore.getState();
		lastSavedContentRef.current = processContent(savedContent, trimTrailingWhitespace);
		awaitingNewFileRef.current = false;
		setSaveStatus("saved");
	}, []);

	const waitForPending = useCallback((): Promise<void> => {
		return inflightRef.current;
	}, []);

	return { saveStatus, saveNow, markSaved, waitForPending };
}
