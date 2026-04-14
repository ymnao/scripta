import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveStatus } from "../components/layout/StatusBar";
import { writeFile } from "../lib/commands";
import { processContent } from "../lib/content";
import { isTransientError, translateError } from "../lib/errors";
import { useSettingsStore } from "../stores/settings";
import { useToastStore } from "../stores/toast";

const MAX_SAVE_RETRIES = 3;
const SAVE_RETRY_BASE_MS = 5000;
const IME_COMPOSITION_DEFER_MS = 200;

interface UseAutoSaveReturn {
	saveStatus: SaveStatus;
	saveNow: () => Promise<boolean>;
	markSaved: (content: string) => void;
	waitForPending: () => Promise<void>;
	getLastSavedContent: () => string;
}

export function useAutoSave(
	filePath: string,
	content: string,
	isComposing?: () => boolean,
	onFlushComplete?: (path: string, savedContent: string) => void,
): UseAutoSaveReturn {
	const autoSaveDelay = useSettingsStore((s) => s.autoSaveDelay);
	const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
	const contentRef = useRef(content);
	contentRef.current = content;
	const isComposingRef = useRef(isComposing);
	isComposingRef.current = isComposing;
	const onFlushCompleteRef = useRef(onFlushComplete);
	onFlushCompleteRef.current = onFlushComplete;
	const lastSavedContentRef = useRef(
		processContent(content, useSettingsStore.getState().trimTrailingWhitespace),
	);
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isMountedRef = useRef(true);
	const saveIdRef = useRef(0);
	const prevFilePathRef = useRef(filePath);
	const awaitingNewFileRef = useRef(false);
	const inflightRef = useRef<Promise<void>>(Promise.resolve());
	const saveRetryCountRef = useRef(0);
	const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearRetryState = useCallback(() => {
		if (retryTimerRef.current) {
			clearTimeout(retryTimerRef.current);
			retryTimerRef.current = null;
		}
		saveRetryCountRef.current = 0;
	}, []);

	const save = useCallback(
		(contentToSave: string): Promise<void> => {
			if (!filePath) return Promise.resolve();
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
					clearRetryState();

					// Content may have changed while the write was in flight.
					// The content effect may have already evaluated and found
					// no diff (against the OLD lastSavedRef), so it won't
					// re-run. Detect the mismatch and schedule a follow-up.
					const { trimTrailingWhitespace: tw, autoSaveDelay: followUpDelay } =
						useSettingsStore.getState();
					const currentProcessed = processContent(contentRef.current, tw);
					if (currentProcessed !== processed) {
						setSaveStatus("unsaved");
						if (debounceTimerRef.current) {
							clearTimeout(debounceTimerRef.current);
						}
						debounceTimerRef.current = setTimeout(function tryFollowUp() {
							if (isComposingRef.current?.()) {
								debounceTimerRef.current = setTimeout(tryFollowUp, IME_COMPOSITION_DEFER_MS);
								return;
							}
							save(contentRef.current).catch(() => {});
						}, followUpDelay);
					} else {
						setSaveStatus("saved");
					}
				},
				(err) => {
					if (isMountedRef.current && currentSaveId === saveIdRef.current) {
						console.error("Failed to save file:", err);
						if (isTransientError(err) && saveRetryCountRef.current < MAX_SAVE_RETRIES) {
							saveRetryCountRef.current += 1;
							const delay = SAVE_RETRY_BASE_MS * 2 ** (saveRetryCountRef.current - 1);
							setSaveStatus("retrying");
							retryTimerRef.current = setTimeout(function tryRetry() {
								if (isComposingRef.current?.()) {
									retryTimerRef.current = setTimeout(tryRetry, IME_COMPOSITION_DEFER_MS);
									return;
								}
								save(contentRef.current).catch(() => {});
							}, delay);
						} else {
							setSaveStatus("error");
							if (saveRetryCountRef.current > 0) {
								useToastStore
									.getState()
									.addToast("error", `ファイルの保存に失敗しました: ${translateError(err)}`);
							}
						}
					}
					throw err;
				},
			);
		},
		[filePath, clearRetryState],
	);

	// Flush pending changes to the OLD path when filePath changes
	useEffect(() => {
		if (filePath === prevFilePathRef.current) return;

		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}

		// Clear retry state on file switch
		clearRetryState();

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
			if (isComposingRef.current?.()) {
				// Composition 中はステータスを更新せず旧ファイルへ書き込みだけ行う。
				// flush 時点では既に別タブが表示されているため、saveStatus を
				// 変更すると現在のタブの表示が壊れる。
				flushTimerRef.current = setTimeout(function tryFlush() {
					if (isComposingRef.current?.()) {
						flushTimerRef.current = setTimeout(tryFlush, IME_COMPOSITION_DEFER_MS);
						return;
					}
					flushTimerRef.current = null;
					const p = inflightRef.current.then(() => writeFile(prevPath, processed));
					inflightRef.current = p.catch(() => {});
					p.then(() => {
						if (!isMountedRef.current) return;
						onFlushCompleteRef.current?.(prevPath, currentContent);
					}).catch((err) => {
						console.error("Failed to save previous file:", err);
					});
				}, IME_COMPOSITION_DEFER_MS);
			} else {
				saveIdRef.current += 1;
				const flushSaveId = saveIdRef.current;
				setSaveStatus("saving");
				const flushPromise = inflightRef.current.then(() => writeFile(prevPath, processed));
				inflightRef.current = flushPromise.catch(() => {});
				flushPromise
					.then(() => {
						if (!isMountedRef.current) return;
						if (flushSaveId !== saveIdRef.current) return;
						onFlushCompleteRef.current?.(prevPath, currentContent);
						setSaveStatus("saved");
					})
					.catch((err) => {
						if (!isMountedRef.current) return;
						if (flushSaveId !== saveIdRef.current) return;
						console.error("Failed to save previous file:", err);
						setSaveStatus("error");
					});
			}
		}
	}, [filePath, clearRetryState]);

	useEffect(() => {
		if (awaitingNewFileRef.current) {
			return;
		}
		if (!filePath) return;
		const { trimTrailingWhitespace } = useSettingsStore.getState();
		if (processContent(content, trimTrailingWhitespace) === lastSavedContentRef.current) {
			return;
		}
		setSaveStatus("unsaved");

		// Clear retry state on content change (new debounce save will take over)
		clearRetryState();

		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
		}
		debounceTimerRef.current = setTimeout(function tryAutoSave() {
			if (isComposingRef.current?.()) {
				debounceTimerRef.current = setTimeout(tryAutoSave, IME_COMPOSITION_DEFER_MS);
				return;
			}
			save(contentRef.current).catch(() => {});
		}, autoSaveDelay);
		return () => {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
		};
	}, [content, filePath, save, autoSaveDelay, clearRetryState]);

	useEffect(() => {
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
			}
			if (flushTimerRef.current) {
				clearTimeout(flushTimerRef.current);
			}
			if (retryTimerRef.current) {
				clearTimeout(retryTimerRef.current);
			}
		};
	}, []);

	const saveNow = useCallback((): Promise<boolean> => {
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}
		clearRetryState();
		return save(contentRef.current).then(
			() => true,
			() => false,
		);
	}, [save, clearRetryState]);

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

	const getLastSavedContent = useCallback((): string => {
		return lastSavedContentRef.current;
	}, []);

	return { saveStatus, saveNow, markSaved, waitForPending, getLastSavedContent };
}
