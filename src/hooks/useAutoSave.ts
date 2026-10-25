import { type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import type { SaveStatus } from "../components/layout/StatusBar";
import { writeFile } from "../lib/commands";
import { processContent } from "../lib/content";
import { isTransientError, translateError } from "../lib/errors";
import { addTrailingSep } from "../lib/path";
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
	/**
	 * 開いているファイルが rename されたことを知らせる。filePath の変化を
	 * 「別ファイルへの切替」と誤認して **旧 path へ flush write する**
	 * (= rename で消えたはずのファイルを disk 上に作り直す) のを防ぐ。
	 */
	notifyPathRenamed: (oldPath: string, newPath: string) => void;
	/**
	 * ファイル (isDirectory なら配下全体) が削除されたことを知らせる。開いている
	 * ファイルが含まれていれば未保存の編集を捨て、直後の filePath の変化で
	 * **削除した path へ flush write する** (= 削除したファイルを disk 上に作り直す) のを防ぐ。
	 * saveStatus は戻さないので、呼び出し側は続けてタブを閉じる (切替後の markSaved で戻る)。
	 */
	notifyPathDeleted: (path: string, isDirectory: boolean) => void;
	/**
	 * 外部変更のダイアログで user が選ぶまで、タイマー (debounce / follow-up / retry) による
	 * 書き込みを止める。止めないと、選ぶ前に未保存の内容が disk の外部変更を上書きする。
	 * saveNow と切替時の flush は止めない。
	 */
	holdAutoSave: () => void;
	/** holdAutoSave を解き、打鍵と同じく未保存の内容が残っていれば debounce を張り直す。 */
	releaseAutoSave: () => void;
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
	// 追跡中のファイルが削除されたときに進める。saveId で代用しないのは、saveId が切替元への
	// flush と共有で、進めると別ファイルへの flush の完了 (onFlushComplete) まで無効になるため。
	// 切替では進めない: write 中の切替は必ず flush になり、その saveId が完了処理を無効にする。
	const trackGenerationRef = useRef(0);
	const prevFilePathRef = useRef(filePath);
	const awaitingNewFileRef = useRef(false);
	const inflightRef = useRef<Promise<void>>(Promise.resolve());
	// 追跡中のファイルへ最後に書き始めた本文。完了前の切替では lastSavedContentRef がまだ前の
	// 本文なので、「保存済みの本文へ戻してから切り替えた」ときに flush 不要と誤判定しないよう
	// 併せて見る。完了時に消さないのは、残っていても起きるのは追跡中のファイルへ今の本文を
	// 書き直す余分な flush だけで、別のファイルへは書かないため。切替で追跡が替わるときに捨てる。
	const pendingContentRef = useRef<string | null>(null);
	const saveRetryCountRef = useRef(0);
	const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const heldRef = useRef(false);

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
				timerRef.current = null;
			}
			if (heldRef.current) return;
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
			// render 時の filePath を使わないのは、タイマーがこの closure を抱えたまま
			// rename を跨ぎ、発火時に旧 path へ書くため。
			const trackedPath = prevFilePathRef.current;
			if (!trackedPath) return Promise.resolve();
			// 追跡中のファイルが削除された後に完了した write は、follow-up・retry・saveStatus を
			// 更新しない。更新すると、閉じた後のエディタが unsaved / retrying のまま残る。
			const generation = trackGenerationRef.current;
			const { trimTrailingWhitespace } = useSettingsStore.getState();
			const processed = processContent(contentToSave, trimTrailingWhitespace);
			if (processed === lastSavedContentRef.current) {
				return Promise.resolve();
			}
			saveIdRef.current += 1;
			const currentSaveId = saveIdRef.current;
			setSaveStatus("saving");
			const writePromise = inflightRef.current.then(() => writeFile(trackedPath, processed));
			inflightRef.current = writePromise.catch(() => {});
			pendingContentRef.current = processed;
			return writePromise.then(
				() => {
					if (!isMountedRef.current) return;
					if (currentSaveId !== saveIdRef.current) return;
					if (generation !== trackGenerationRef.current) return;
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
					if (
						isMountedRef.current &&
						currentSaveId === saveIdRef.current &&
						generation === trackGenerationRef.current
					) {
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
		[clearRetryState, scheduleWithComposition],
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
		const pending = pendingContentRef.current;
		const hadUnsavedChanges =
			prevPath &&
			(processed !== lastSavedContentRef.current || (pending !== null && processed !== pending));
		pendingContentRef.current = null;
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
						// flush が書いたのは **切替前のファイル**。完了しても「今表示している
						// タブが保存済み」とは限らない (切替先が cache から dirty のまま復元
						// された、あるいは元のタブへ戻って編集を続けた場合)。無条件に
						// "saved" にすると dirty 表示が消えるだけでなく、呼び出し側の
						// 「保存済み内容」の追跡まで未保存の内容へ進み、window close 時の
						// 一括保存がそのタブを skip して編集が失われる。
						// ただし切替先の内容がまだ markSaved で渡されていない間 (awaitingNewFile) は
						// 判定材料が無いので従来どおり "saved" に落ち着かせ、markSaved 側の
						// dirty 導出に委ねる。
						const { trimTrailingWhitespace: tw } = useSettingsStore.getState();
						const stillDirty =
							!awaitingNewFileRef.current &&
							processContent(getContentRef.current(), tw) !== lastSavedContentRef.current;
						setSaveStatus(stillDirty ? "unsaved" : "saved");
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

	// rename は「同じ文書の path が変わった」だけなので、prevFilePathRef を付け替えて
	// flush-on-path-change effect を素通りさせる。付け替えないと effect は旧 path を
	// 「切替元のファイル」とみなして書き込み、main 側は書き込み先の親ディレクトリを
	// 作り直すため、rename で消えたはずの path がゴーストとして復活する。
	const notifyPathRenamed = useCallback((oldPath: string, newPath: string): void => {
		if (prevFilePathRef.current === oldPath) {
			prevFilePathRef.current = newPath;
		}
	}, []);

	// 追跡を空にすると、切替 effect は「切替元のファイル無し」として flush を飛ばし、
	// 残ったタイマーが発火しても save は書き先が無いので何もしない。
	const notifyPathDeleted = useCallback((path: string, isDirectory: boolean): void => {
		const tracked = prevFilePathRef.current;
		if (!(isDirectory ? tracked.startsWith(addTrailingSep(path)) : tracked === path)) return;
		prevFilePathRef.current = "";
		trackGenerationRef.current += 1;
	}, []);

	const holdAutoSave = useCallback((): void => {
		heldRef.current = true;
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}
		clearRetryState();
	}, [clearRetryState]);

	// debounce を直接張らないのは、切替直後 (切替先の markSaved 前) に解かれると、
	// 切替元の本文を切替先の path へ書く timer が張られるため。scheduleAutoSave の
	// awaitingNewFile ゲートを通す。
	const releaseAutoSave = useCallback((): void => {
		heldRef.current = false;
		scheduleAutoSave();
	}, [scheduleAutoSave]);

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
		notifyPathRenamed,
		notifyPathDeleted,
		holdAutoSave,
		releaseAutoSave,
	};
}
