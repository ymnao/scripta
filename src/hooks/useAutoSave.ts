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
	const lastSavedContentRef = useRef(content);
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isMountedRef = useRef(true);
	const saveIdRef = useRef(0);

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

	useEffect(() => {
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
		save(content);
	}, [content, save]);

	const markSaved = useCallback((savedContent: string) => {
		lastSavedContentRef.current = savedContent;
		setSaveStatus("saved");
	}, []);

	return { saveStatus, saveNow, markSaved };
}
