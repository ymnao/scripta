import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import type { SaveStatus } from "../components/layout/StatusBar";
import { writeFile } from "../lib/commands";
import { processContent } from "../lib/content";
import { isTransientError, translateError } from "../lib/errors";
import { useSettingsStore } from "../stores/settings";
import { useToastStore } from "../stores/toast";

const MAX_SAVE_RETRIES = 3;
const SAVE_RETRY_BASE_MS = 5000;
const IME_COMPOSITION_DEFER_MS = 200;

function saveErrorMessage(err: unknown): string {
	return `ファイルの保存に失敗しました: ${translateError(err)}`;
}

interface SaveOptions {
	skipRetry?: boolean;
}

interface UseAutoSaveReturn {
	saveStatus: SaveStatus;
	saveNow: () => Promise<boolean>;
	// currentContent 省略で従来通り status="saved" 化のみ。
	// タブ切替キャッシュ復元等で「savedContent と現在の doc が異なる」ロード時に
	// currentContent を渡すと dirty 状態を導出し debounce autosave を張る (#302)。
	markSaved: (savedContent: string, currentContent?: string) => void;
	waitForPending: () => Promise<void>;
	getLastSavedContent: () => string;
	scheduleAutoSave: () => void;
}

export function useAutoSave(
	filePath: string,
	getContent: () => string,
	isComposing?: () => boolean,
	onFlushComplete?: (path: string, rawContent: string) => void,
): UseAutoSaveReturn {
	const autoSaveDelay = useSettingsStore((s) => s.autoSaveDelay);
	const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
	// scheduleAutoSave() は keystroke ごとに呼ばれる（React state の外）ため、
	// ref で同期して「既に unsaved なら full-doc processContent を skip」の判定を
	// この tick 内で正しく行えるようにする。他の ref と同じレンダー本体で代入
	// （effect 経由だと saved→unsaved 遷移直後の keystroke で 1 tick 遅れうる）。
	const saveStatusRef = useRef(saveStatus);
	saveStatusRef.current = saveStatus;
	const getContentRef = useRef(getContent);
	getContentRef.current = getContent;
	const isComposingRef = useRef(isComposing);
	isComposingRef.current = isComposing;
	const onFlushCompleteRef = useRef(onFlushComplete);
	onFlushCompleteRef.current = onFlushComplete;
	const lastSavedContentRef = useRef(
		processContent(getContent(), useSettingsStore.getState().trimTrailingWhitespace),
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

	// IME composition 中は保存を defer するタイマーを張る共通 helper。
	// timerRef の張り直し + composition ループ + action の 3 パーツをカプセル化して、
	// autosave debounce / follow-up / retry の 3 経路で同じ挙動を保つ。
	const scheduleWithComposition = useCallback(
		(
			timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
			delay: number,
			action: () => void,
		): void => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
			timerRef.current = setTimeout(function tick() {
				if (isComposingRef.current?.()) {
					timerRef.current = setTimeout(tick, IME_COMPOSITION_DEFER_MS);
					return;
				}
				action();
			}, delay);
		},
		[],
	);

	const save = useCallback(
		(contentToSave: string, options?: SaveOptions): Promise<void> => {
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
					const currentProcessed = processContent(getContentRef.current(), tw);
					if (currentProcessed !== processed) {
						setSaveStatus("unsaved");
						scheduleWithComposition(debounceTimerRef, followUpDelay, () => {
							save(getContentRef.current()).catch(() => {});
						});
					} else {
						setSaveStatus("saved");
					}
				},
				(err) => {
					if (isMountedRef.current && currentSaveId === saveIdRef.current) {
						console.error("Failed to save file:", err);
						if (
							!options?.skipRetry &&
							isTransientError(err) &&
							saveRetryCountRef.current < MAX_SAVE_RETRIES
						) {
							saveRetryCountRef.current += 1;
							const delay = SAVE_RETRY_BASE_MS * 2 ** (saveRetryCountRef.current - 1);
							setSaveStatus("retrying");
							scheduleWithComposition(retryTimerRef, delay, () => {
								save(getContentRef.current()).catch(() => {});
							});
						} else {
							setSaveStatus("error");
							if (saveRetryCountRef.current > 0) {
								useToastStore.getState().addToast("error", saveErrorMessage(err));
							}
						}
					}
					throw err;
				},
			);
		},
		[filePath, clearRetryState, scheduleWithComposition],
	);

	// Flush pending changes to the OLD path when filePath changes
	useEffect(() => {
		if (filePath === prevFilePathRef.current) return;

		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}

		// 直前の filePath 変更で残った IME composition 中の flush タイマーをクリア。
		// 残しておくと「2 つ前の path の中間 IME 状態の書き戻し」が後で発火する。
		if (flushTimerRef.current) {
			clearTimeout(flushTimerRef.current);
			flushTimerRef.current = null;
		}

		// Clear retry state on file switch
		clearRetryState();

		const prevPath = prevFilePathRef.current;
		const currentContent = getContentRef.current();
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

	const scheduleAutoSave = useCallback((): void => {
		if (awaitingNewFileRef.current) return;
		if (!filePath) return;

		// Fast path: 既に "unsaved" なら full-doc processContent 比較を skip し、
		// debounce タイマーの張り替えだけ行う。これが #302 の per-keystroke O(1) 化の要。
		// 「typed then undo to saved」は save() 側の同じ equality check で最終的に握られる
		// (write は走らない)。retry / error 状態からの遷移も含めるため、判定は
		// `!== "unsaved"` (== "saved" ではなく)。
		if (saveStatusRef.current !== "unsaved") {
			const { trimTrailingWhitespace } = useSettingsStore.getState();
			if (
				processContent(getContentRef.current(), trimTrailingWhitespace) ===
				lastSavedContentRef.current
			) {
				return;
			}
			setSaveStatus("unsaved");
			// Clear retry state on saved→unsaved transition (new debounce save will take over)
			clearRetryState();
		}

		scheduleWithComposition(debounceTimerRef, autoSaveDelay, () => {
			save(getContentRef.current()).catch(() => {});
		});
	}, [filePath, save, autoSaveDelay, clearRetryState, scheduleWithComposition]);

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
		// 親の markSaved 漏れでゲートが立ったままになると autosave が永久に止まる。
		// 手動セーブ完了時点で「現在のファイル」を書いた事実があるので safety net として解除。
		awaitingNewFileRef.current = false;
		const promise = save(getContentRef.current(), { skipRetry: true });
		// Capture the saveId that save() just assigned so we can detect
		// whether a newer save superseded this one before the error fires.
		const id = saveIdRef.current;
		return promise.then(
			() => true,
			(err) => {
				if (isMountedRef.current && id === saveIdRef.current) {
					useToastStore.getState().addToast("error", saveErrorMessage(err));
				}
				return false;
			},
		);
	}, [save, clearRetryState]);

	const markSaved = useCallback(
		(savedContent: string, currentContent?: string): void => {
			// Normalize to match the format written to disk for consistent comparison
			const { trimTrailingWhitespace } = useSettingsStore.getState();
			const processedSaved = processContent(savedContent, trimTrailingWhitespace);
			lastSavedContentRef.current = processedSaved;
			awaitingNewFileRef.current = false;

			// キャッシュ復元で「disk に書けなかった編集が残ったまま復帰する」ケース (#302
			// regression fix)。currentContent と savedContent が processContent 適用後で
			// 一致すれば従来通り "saved"。異なれば dirty 状態を導出し debounce autosave を張る。
			const dirty =
				currentContent !== undefined &&
				processContent(currentContent, trimTrailingWhitespace) !== processedSaved;
			if (dirty) {
				setSaveStatus("unsaved");
				clearRetryState();
				scheduleWithComposition(debounceTimerRef, autoSaveDelay, () => {
					save(getContentRef.current()).catch(() => {});
				});
			} else {
				setSaveStatus("saved");
			}
		},
		[autoSaveDelay, clearRetryState, save, scheduleWithComposition],
	);

	const waitForPending = useCallback((): Promise<void> => {
		return inflightRef.current;
	}, []);

	const getLastSavedContent = useCallback((): string => {
		return lastSavedContentRef.current;
	}, []);

	return {
		saveStatus,
		saveNow,
		markSaved,
		waitForPending,
		getLastSavedContent,
		scheduleAutoSave,
	};
}
