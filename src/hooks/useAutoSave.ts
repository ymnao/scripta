import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveStatus } from "../components/layout/StatusBar";
import { writeFile } from "../lib/commands";

const DEBOUNCE_MS = 2000;

interface UseAutoSaveReturn {
	saveStatus: SaveStatus;
	saveNow: () => Promise<boolean>;
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
	const inflightRef = useRef<Promise<void>>(Promise.resolve());

	const save = useCallback(
		(contentToSave: string): Promise<void> => {
			if (contentToSave === lastSavedContentRef.current) {
				return Promise.resolve();
			}
			saveIdRef.current += 1;
			const currentSaveId = saveIdRef.current;
			setSaveStatus("saving");
			const writePromise = inflightRef.current.then(() => writeFile(filePath, contentToSave));
			inflightRef.current = writePromise.catch(() => {});
			return writePromise.then(
				() => {
					if (!isMountedRef.current) return;
					if (currentSaveId !== saveIdRef.current) return;
					lastSavedContentRef.current = contentToSave;
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
		const hadUnsavedChanges = prevPath && currentContent !== lastSavedContentRef.current;
		prevFilePathRef.current = filePath;
		// Suppress content effect until markSaved is called with the new file's content.
		// This prevents saving stale content from the old file to the new path.
		awaitingNewFileRef.current = true;

		if (hadUnsavedChanges) {
			saveIdRef.current += 1;
			const flushSaveId = saveIdRef.current;
			setSaveStatus("saving");
			const flushPromise = inflightRef.current.then(() => writeFile(prevPath, currentContent));
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
		if (content === lastSavedContentRef.current) {
			return;
		}
		setSaveStatus("unsaved");
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
		}
		debounceTimerRef.current = setTimeout(() => {
			save(content).catch(() => {});
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
		lastSavedContentRef.current = savedContent;
		awaitingNewFileRef.current = false;
		setSaveStatus("saved");
	}, []);

	return { saveStatus, saveNow, markSaved };
}
