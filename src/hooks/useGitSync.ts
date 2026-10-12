import { useCallback, useEffect, useRef } from "react";
import {
	gitAddAll,
	gitCheckAvailable,
	gitCheckRepo,
	gitCommit,
	gitGetLastCommitTime,
	gitPull,
	gitPush,
	gitResolveSyncBranch,
	gitStatus,
	onConflictResolved,
} from "../lib/commands";
import { isNetworkError, translateError } from "../lib/errors";
import { useGitSyncStore } from "../stores/git-sync";
import { useToastStore } from "../stores/toast";
import { getErrorKind } from "../types/errors";
import { formatSyncHaltMessage, getSyncHalt } from "../types/git-sync";

class GitOperationQueue {
	private queue: Array<() => Promise<void>> = [];
	private rejecters: Array<(reason: Error) => void> = [];
	private running = false;
	private cancelled = false;

	async enqueue<T>(fn: () => Promise<T>): Promise<T> {
		if (this.cancelled) {
			return Promise.reject(new Error("Queue cancelled"));
		}
		return new Promise<T>((resolve, reject) => {
			const rejectEntry = reject as (reason: Error) => void;
			this.rejecters.push(rejectEntry);
			this.queue.push(async () => {
				// Remove from rejecters — this task is now executing, not pending
				const idx = this.rejecters.indexOf(rejectEntry);
				if (idx !== -1) this.rejecters.splice(idx, 1);
				try {
					resolve(await fn());
				} catch (e) {
					reject(e);
				}
			});
			if (!this.running) {
				void this.process();
			}
		});
	}

	cancel(): void {
		this.cancelled = true;
		const cancelError = new Error("Queue cancelled");
		for (const reject of this.rejecters) {
			reject(cancelError);
		}
		this.queue.length = 0;
		this.rejecters.length = 0;
	}

	private async process(): Promise<void> {
		this.running = true;
		while (this.queue.length > 0 && !this.cancelled) {
			const task = this.queue.shift();
			if (task) {
				await task();
			}
		}
		this.running = false;
	}
}

function expandCommitMessage(template: string): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	return template.replace(/\{\{date\}\}/g, date);
}

function isBranchMismatch(e: unknown): boolean {
	return getErrorKind(e) === "GIT_BRANCH_MISMATCH";
}

type SyncResult = "done" | "skipped" | "halted";

function notifyManualSyncResult(result: SyncResult): void {
	if (result === "skipped") return;
	const toast = useToastStore.getState();
	const s = useGitSyncStore.getState();
	if (result === "halted") {
		if (s.syncHalt) toast.addToast("warning", formatSyncHaltMessage(s.syncHalt));
	} else if (s.errorMessage) {
		toast.addToast("error", `同期に失敗しました: ${s.errorMessage}`);
	} else if (s.offlineMode) {
		toast.addToast("warning", "ネットワークに接続できません。ローカル変更のみ保存されました。");
	} else {
		toast.addToast("success", "同期が完了しました");
	}
}

interface UseGitSyncOptions {
	workspacePath: string | null;
}

export function useGitSync({ workspacePath }: UseGitSyncOptions): {
	manualSync: () => void;
} {
	const queueRef = useRef(new GitOperationQueue());
	const commitTimerRef = useRef(0);
	const pullTimerRef = useRef(0);
	const pushTimerRef = useRef(0);
	const pausedRef = useRef(false);
	const workspacePathRef = useRef(workspacePath);
	workspacePathRef.current = workspacePath;

	const clearTimers = useCallback(() => {
		clearTimeout(commitTimerRef.current);
		clearTimeout(pullTimerRef.current);
		clearTimeout(pushTimerRef.current);
		commitTimerRef.current = 0;
		pullTimerRef.current = 0;
		pushTimerRef.current = 0;
	}, []);

	// 戻り値は自動同期してよいときの対象ブランチ。止めるべきとき・状態を読めなかったときは null。
	const refreshStatus = useCallback(async (path: string): Promise<string | null> => {
		try {
			const [status, time, syncBranch] = await Promise.all([
				gitStatus(path),
				gitGetLastCommitTime(path),
				gitResolveSyncBranch(path, useGitSyncStore.getState().gitSyncBranch),
			]);
			if (workspacePathRef.current !== path) return null;
			const store = useGitSyncStore.getState();
			store.setBranch(status.branch);
			store.setHasRemote(status.hasRemote);
			store.setConflictFiles(status.conflictFiles);
			pausedRef.current = status.conflictFiles.length > 0;
			store.setLastCommitTime(time);
			const halt = getSyncHalt(status, syncBranch);
			store.setSyncHalt(halt);
			return halt === null ? syncBranch : null;
		} catch {
			// status check failure is non-fatal
			return null;
		}
	}, []);

	const doPull = useCallback(
		async (path: string, syncBranch: string) => {
			if (workspacePathRef.current !== path) return;
			const store = useGitSyncStore.getState();
			if (pausedRef.current || !store.hasRemote) return;

			try {
				store.setGitAction("pull");
				await gitPull(path, store.syncMethod, syncBranch);
				if (workspacePathRef.current !== path) return;
				store.setOfflineMode(false);
				store.setErrorMessage(null);
				await refreshStatus(path);
			} catch (e) {
				if (workspacePathRef.current !== path) throw e;
				if (isBranchMismatch(e)) {
					await refreshStatus(path);
				} else if (isNetworkError(e)) {
					store.setOfflineMode(true);
					store.setErrorMessage(null);
				} else {
					store.setErrorMessage(translateError(e));
					// Refresh status so conflict detection works even after pull failure
					await refreshStatus(path);
				}
				throw e;
			} finally {
				if (workspacePathRef.current === path) {
					store.setGitAction("idle");
				}
			}
		},
		[refreshStatus],
	);

	const doPush = useCallback(
		async (path: string, syncBranch: string) => {
			if (workspacePathRef.current !== path) return;
			const store = useGitSyncStore.getState();
			if (!store.hasRemote || store.offlineMode || pausedRef.current) return;

			try {
				store.setGitAction("push");
				await gitPush(path, syncBranch);
				if (workspacePathRef.current !== path) return;
				store.setOfflineMode(false);
				store.setErrorMessage(null);
			} catch (e) {
				if (workspacePathRef.current !== path) throw e;
				if (isBranchMismatch(e)) {
					await refreshStatus(path);
				} else if (isNetworkError(e)) {
					store.setOfflineMode(true);
					store.setErrorMessage(null);
				} else {
					store.setErrorMessage(translateError(e));
				}
				throw e;
			} finally {
				if (workspacePathRef.current === path) {
					store.setGitAction("idle");
				}
			}
		},
		[refreshStatus],
	);

	// タイマーの発火ごとに状態を読み直してから pull / push する。外部のツールが
	// ブランチを切り替えるので、起動時の判定だけでは足りない（#639）。
	// 状態の読み直しは conflict の外部解消を検出する役目も兼ねる（remote が無い repo でも）。
	const autoPull = useCallback(
		async (path: string) => {
			const syncBranch = await refreshStatus(path);
			if (syncBranch === null) return;
			await doPull(path, syncBranch);
		},
		[doPull, refreshStatus],
	);

	const autoPush = useCallback(
		async (path: string) => {
			const syncBranch = await refreshStatus(path);
			if (syncBranch === null) return;
			await doPush(path, syncBranch);
		},
		[doPush, refreshStatus],
	);

	const doCommitAndSync = useCallback(
		async (path: string): Promise<SyncResult> => {
			if (workspacePathRef.current !== path) return "done";
			const store = useGitSyncStore.getState();
			// Refreshing also detects external conflict resolution.
			const syncBranch = await refreshStatus(path);
			if (workspacePathRef.current !== path) return "done";
			if (pausedRef.current) return "skipped";
			if (syncBranch === null) return "halted";

			try {
				store.setGitAction("add");
				await gitAddAll(path, syncBranch);
				if (workspacePathRef.current !== path) return "done";

				store.setGitAction("commit");
				const message = expandCommitMessage(store.commitMessage);
				let committed = true;
				try {
					await gitCommit(path, message, syncBranch);
				} catch (e) {
					if (getErrorKind(e) === "GIT_NOTHING_TO_COMMIT") {
						committed = false;
					} else {
						throw e;
					}
				}
				if (workspacePathRef.current !== path) return "done";

				if (committed || store.hasRemote) {
					if (store.pullBeforePush && store.hasRemote) {
						try {
							await doPull(path, syncBranch);
						} catch (e) {
							// doPull already set errorMessage and refreshed status.
							// Stop here — do not proceed to push after a failed pull.
							return isBranchMismatch(e) ? "halted" : "done";
						}
					}
					if (store.hasRemote && !store.offlineMode && !pausedRef.current) {
						try {
							await doPush(path, syncBranch);
						} catch (e) {
							// doPush already set state (offlineMode/errorMessage).
							// Stop the success path — do not clear errorMessage.
							await refreshStatus(path);
							return isBranchMismatch(e) ? "halted" : "done";
						}
					}
				}

				if (workspacePathRef.current !== path) return "done";
				store.setErrorMessage(null);
				await refreshStatus(path);
			} catch (e) {
				if (workspacePathRef.current === path) {
					const halted = isBranchMismatch(e);
					if (!halted) store.setErrorMessage(translateError(e));
					await refreshStatus(path);
					if (halted) return "halted";
				}
			} finally {
				if (workspacePathRef.current === path) {
					store.setGitAction("idle");
				}
			}
			return "done";
		},
		[doPull, doPush, refreshStatus],
	);

	// Initialize on workspace change
	useEffect(() => {
		// Cancel the old queue and create a new one for the new workspace
		queueRef.current.cancel();
		queueRef.current = new GitOperationQueue();

		if (!workspacePath) {
			useGitSyncStore.getState().resetRuntime();
			clearTimers();
			return;
		}

		let cancelled = false;
		const path = workspacePath;

		void (async () => {
			try {
				const available = await gitCheckAvailable();
				if (cancelled) return;
				useGitSyncStore.getState().setGitAvailable(available);
				if (!available) return;

				const isRepo = await gitCheckRepo(path);
				if (cancelled) return;
				useGitSyncStore.getState().setGitReady(isRepo);
				if (!isRepo) return;

				await refreshStatus(path);
				if (cancelled) return;

				const store = useGitSyncStore.getState();
				if (store.autoPullOnStartup && store.hasRemote && store.gitSyncEnabled) {
					try {
						await queueRef.current.enqueue(() => autoPull(path));
					} catch {
						// Startup pull failure is non-fatal; doPull already updated state.
					}
				}
				// Timers are scheduled by the separate settings-reactive useEffect below
			} catch {
				// Initialization failure is non-fatal; state remains at defaults.
			}
		})();

		return () => {
			cancelled = true;
			clearTimers();
			useGitSyncStore.getState().resetRuntime();
		};
	}, [workspacePath, clearTimers, refreshStatus, autoPull]);

	// Re-schedule timers when interval settings change.
	// Subscribe to store values so the effect re-runs when they change.
	const gitSyncEnabled = useGitSyncStore((s) => s.gitSyncEnabled);
	const autoCommitInterval = useGitSyncStore((s) => s.autoCommitInterval);
	const autoPullInterval = useGitSyncStore((s) => s.autoPullInterval);
	const autoPushInterval = useGitSyncStore((s) => s.autoPushInterval);
	const gitReady = useGitSyncStore((s) => s.gitReady);

	useEffect(() => {
		if (!workspacePath || !gitReady || !gitSyncEnabled) {
			clearTimers();
			return;
		}

		// Read intervals to schedule timers. These values in the dependency array
		// ensure the effect re-runs when settings change.
		const commitMs = autoCommitInterval > 0 ? autoCommitInterval * 60 * 1000 : 0;
		const pullMs = autoPullInterval > 0 ? autoPullInterval * 60 * 1000 : 0;
		const pushMs = autoPushInterval > 0 ? autoPushInterval * 60 * 1000 : 0;
		const path = workspacePath;
		let cancelled = false;

		if (commitMs > 0) {
			const tick = () => {
				if (cancelled) return;
				commitTimerRef.current = window.setTimeout(() => {
					void queueRef.current.enqueue(() => doCommitAndSync(path)).then(tick, tick);
				}, commitMs);
			};
			tick();
		}
		if (pullMs > 0) {
			const tick = () => {
				if (cancelled) return;
				pullTimerRef.current = window.setTimeout(() => {
					void queueRef.current.enqueue(() => autoPull(path)).then(tick, tick);
				}, pullMs);
			};
			tick();
		}
		if (pushMs > 0) {
			const tick = () => {
				if (cancelled) return;
				pushTimerRef.current = window.setTimeout(() => {
					void queueRef.current.enqueue(() => autoPush(path)).then(tick, tick);
				}, pushMs);
			};
			tick();
		}

		return () => {
			cancelled = true;
			clearTimers();
		};
	}, [
		workspacePath,
		gitReady,
		gitSyncEnabled,
		autoCommitInterval,
		autoPullInterval,
		autoPushInterval,
		clearTimers,
		doCommitAndSync,
		autoPull,
		autoPush,
	]);

	// 同期するブランチの設定を変えたら、次のタイマーを待たずにステータスバーへ反映する。
	useEffect(() => {
		if (!workspacePath) return;
		const path = workspacePath;
		return useGitSyncStore.subscribe((s, prev) => {
			if (s.gitSyncBranch === prev.gitSyncBranch || !s.gitReady) return;
			void queueRef.current
				.enqueue(() => refreshStatus(path))
				.catch(() => {
					// Queue cancelled (e.g. workspace switch) — ignore silently
				});
		});
	}, [workspacePath, refreshStatus]);

	// Listen for conflict resolution
	useEffect(() => {
		const handleConflictResolved = (resolvedWorkspacePath: string) => {
			// 別 workspace の conflict 解消イベントで自分の paused 状態が
			// 誤ってクリアされないよう、payload を照合する。
			// （main 側は全 BrowserWindow に broadcast している）
			if (!workspacePath || resolvedWorkspacePath !== workspacePath) return;
			pausedRef.current = false;
			void refreshStatus(workspacePath);
			// Timer re-scheduling happens automatically via the settings-reactive useEffect
		};

		const unlisten = onConflictResolved(handleConflictResolved);
		return () => unlisten();
	}, [workspacePath, refreshStatus]);

	const manualSync = useCallback(() => {
		if (!workspacePath) return;
		const store = useGitSyncStore.getState();
		if (!store.gitSyncEnabled) {
			useToastStore.getState().addToast("info", "Git 同期が無効です。設定から有効にしてください。");
			return;
		}
		if (!store.gitReady) {
			useToastStore.getState().addToast("info", "Git リポジトリが検出されませんでした。");
			return;
		}
		if (store.conflictFiles.length > 0) {
			// Re-check status — conflicts may have been resolved externally (CLI, etc.)
			const path = workspacePath;
			void queueRef.current
				.enqueue(async () => {
					await refreshStatus(path);
					const updated = useGitSyncStore.getState();
					if (updated.conflictFiles.length > 0) {
						useToastStore
							.getState()
							.addToast("warning", "コンフリクトを解消してから同期してください。");
					} else {
						useToastStore
							.getState()
							.addToast("info", "コンフリクトが解消されました。同期を開始しています...");
						notifyManualSyncResult(await doCommitAndSync(path));
					}
				})
				.catch(() => {
					// Queue cancelled (e.g. workspace switch) — ignore silently
				});
			return;
		}
		const path = workspacePath;
		useToastStore.getState().addToast("info", "同期を開始しています...");
		void queueRef.current
			.enqueue(async () => {
				notifyManualSyncResult(await doCommitAndSync(path));
			})
			.catch(() => {
				// Queue cancelled (e.g. workspace switch) — ignore silently
			});
	}, [workspacePath, doCommitAndSync, refreshStatus]);

	return { manualSync };
}
