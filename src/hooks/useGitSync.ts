import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import {
	gitAddAll,
	gitCheckAvailable,
	gitCheckRepo,
	gitCommit,
	gitGetLastCommitTime,
	gitPull,
	gitPush,
	gitStatus,
} from "../lib/commands";
import { isNetworkError } from "../lib/errors";
import { useGitSyncStore } from "../stores/git-sync";
import { useToastStore } from "../stores/toast";

class GitOperationQueue {
	private queue: Array<() => Promise<void>> = [];
	private running = false;

	async enqueue(fn: () => Promise<void>): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.queue.push(async () => {
				try {
					await fn();
					resolve();
				} catch (e) {
					reject(e);
				}
			});
			if (!this.running) {
				void this.process();
			}
		});
	}

	private async process(): Promise<void> {
		this.running = true;
		while (this.queue.length > 0) {
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

	const clearTimers = useCallback(() => {
		clearTimeout(commitTimerRef.current);
		clearTimeout(pullTimerRef.current);
		clearTimeout(pushTimerRef.current);
		commitTimerRef.current = 0;
		pullTimerRef.current = 0;
		pushTimerRef.current = 0;
	}, []);

	const refreshStatus = useCallback(async (path: string) => {
		try {
			const status = await gitStatus(path);
			const store = useGitSyncStore.getState();
			store.setBranch(status.branch);
			store.setHasRemote(status.hasRemote);
			store.setConflictFiles(status.conflictFiles);
			pausedRef.current = status.conflictFiles.length > 0;

			const time = await gitGetLastCommitTime(path);
			store.setLastCommitTime(time);
		} catch {
			// status check failure is non-fatal
		}
	}, []);

	const doPull = useCallback(
		async (path: string) => {
			const store = useGitSyncStore.getState();
			if (!store.hasRemote || pausedRef.current) return;

			try {
				store.setGitAction("pull");
				await gitPull(path, store.syncMethod);
				store.setOfflineMode(false);
				store.setErrorMessage(null);
				await refreshStatus(path);
			} catch (e) {
				if (isNetworkError(e)) {
					store.setOfflineMode(true);
				} else {
					store.setErrorMessage(String(e));
					// Refresh status so conflict detection works even after pull failure
					await refreshStatus(path);
				}
				throw e;
			} finally {
				store.setGitAction("idle");
			}
		},
		[refreshStatus],
	);

	const doPush = useCallback(async (path: string) => {
		const store = useGitSyncStore.getState();
		if (!store.hasRemote || store.offlineMode || pausedRef.current) return;

		try {
			store.setGitAction("push");
			await gitPush(path);
			store.setOfflineMode(false);
			store.setErrorMessage(null);
		} catch (e) {
			if (isNetworkError(e)) {
				store.setOfflineMode(true);
			} else {
				store.setErrorMessage(String(e));
			}
		} finally {
			store.setGitAction("idle");
		}
	}, []);

	const doCommitAndSync = useCallback(
		async (path: string): Promise<"done" | "skipped"> => {
			const store = useGitSyncStore.getState();
			if (pausedRef.current) return "skipped";

			try {
				store.setGitAction("add");
				await gitAddAll(path);

				store.setGitAction("commit");
				const message = expandCommitMessage(store.commitMessage);
				await gitCommit(path, message);

				if (store.pullBeforePush && store.hasRemote) {
					try {
						await doPull(path);
					} catch {
						// doPull already set errorMessage and refreshed status.
						// Stop here — do not proceed to push after a failed pull.
						return "done";
					}
				}
				if (store.hasRemote && !store.offlineMode && !pausedRef.current) {
					await doPush(path);
				}

				store.setErrorMessage(null);
				await refreshStatus(path);
			} catch (e) {
				const msg = String(e);
				// "nothing to commit" is not an error
				if (!msg.includes("nothing to commit")) {
					store.setErrorMessage(msg);
				} else {
					store.setErrorMessage(null);
				}
			} finally {
				store.setGitAction("idle");
			}
			return "done";
		},
		[doPull, doPush, refreshStatus],
	);

	// Initialize on workspace change
	useEffect(() => {
		if (!workspacePath) {
			useGitSyncStore.getState().resetRuntime();
			clearTimers();
			return;
		}

		let cancelled = false;
		const path = workspacePath;

		(async () => {
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
					await queueRef.current.enqueue(() => doPull(path));
				} catch {
					// Startup pull failure is non-fatal; doPull already updated state.
				}
			}
			// Timers are scheduled by the separate settings-reactive useEffect below
		})();

		return () => {
			cancelled = true;
			clearTimers();
			useGitSyncStore.getState().resetRuntime();
		};
	}, [workspacePath, clearTimers, refreshStatus, doPull]);

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

		if (commitMs > 0) {
			const tick = () => {
				commitTimerRef.current = window.setTimeout(() => {
					void queueRef.current.enqueue(() => doCommitAndSync(path)).then(tick, tick);
				}, commitMs);
			};
			tick();
		}
		if (pullMs > 0) {
			const tick = () => {
				pullTimerRef.current = window.setTimeout(() => {
					void queueRef.current.enqueue(() => doPull(path)).then(tick, tick);
				}, pullMs);
			};
			tick();
		}
		if (pushMs > 0) {
			const tick = () => {
				pushTimerRef.current = window.setTimeout(() => {
					void queueRef.current.enqueue(() => doPush(path)).then(tick, tick);
				}, pushMs);
			};
			tick();
		}

		return () => clearTimers();
	}, [
		workspacePath,
		gitReady,
		gitSyncEnabled,
		autoCommitInterval,
		autoPullInterval,
		autoPushInterval,
		clearTimers,
		doCommitAndSync,
		doPull,
		doPush,
	]);

	// Listen for conflict resolution
	useEffect(() => {
		const handleConflictResolved = () => {
			pausedRef.current = false;
			if (workspacePath) {
				void refreshStatus(workspacePath);
				// Timer re-scheduling happens automatically via the settings-reactive useEffect
			}
		};

		let unlisten: (() => void) | null = null;
		let cancelled = false;

		void listen("conflict-resolved", handleConflictResolved).then((fn) => {
			if (cancelled) {
				fn();
			} else {
				unlisten = fn;
			}
		});

		return () => {
			cancelled = true;
			unlisten?.();
		};
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
			useToastStore.getState().addToast("warning", "コンフリクトを解消してから同期してください。");
			return;
		}
		const path = workspacePath;
		const toast = useToastStore.getState();
		toast.addToast("info", "同期を開始しています...");
		void queueRef.current.enqueue(async () => {
			const result = await doCommitAndSync(path);
			if (result === "skipped") return;
			const s = useGitSyncStore.getState();
			if (s.errorMessage) {
				toast.addToast("error", `同期に失敗しました: ${s.errorMessage}`);
			} else {
				toast.addToast("success", "同期が完了しました");
			}
		});
	}, [workspacePath, doCommitAndSync]);

	return { manualSync };
}
