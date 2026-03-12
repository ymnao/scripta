import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import {
	gitAddAll,
	gitCommit,
	gitGetConflictContent,
	gitGetConflictedFiles,
	gitResolveConflict,
} from "../../lib/commands";
import type { ConflictContent } from "../../types/git-sync";
import { ConflictDiffView } from "./ConflictDiffView";
import { ConflictFileList } from "./ConflictFileList";

export function ConflictWindow() {
	const [workspacePath] = useState(
		() => new URLSearchParams(window.location.search).get("workspacePath") ?? "",
	);
	const [files, setFiles] = useState<string[]>([]);
	const [resolvedFiles, setResolvedFiles] = useState<Set<string>>(new Set());
	const [selectedFile, setSelectedFile] = useState<string | null>(null);
	const [conflictContent, setConflictContent] = useState<ConflictContent | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!workspacePath) return;

		gitGetConflictedFiles(workspacePath)
			.then((conflictFiles) => {
				setFiles(conflictFiles);
				if (conflictFiles.length > 0) {
					setSelectedFile(conflictFiles[0]);
				}
				setLoading(false);
			})
			.catch((err) => {
				setError(String(err));
				setLoading(false);
			});
	}, [workspacePath]);

	useEffect(() => {
		if (!workspacePath || !selectedFile) {
			setConflictContent(null);
			return;
		}
		if (resolvedFiles.has(selectedFile)) {
			setConflictContent(null);
			return;
		}

		gitGetConflictContent(workspacePath, selectedFile)
			.then(setConflictContent)
			.catch((err) => {
				setError(String(err));
				setConflictContent(null);
			});
	}, [workspacePath, selectedFile, resolvedFiles]);

	const handleResolve = useCallback(
		async (content: string, resolution: "modify" | "delete") => {
			if (!workspacePath || !selectedFile) return;

			try {
				await gitResolveConflict(workspacePath, selectedFile, content, resolution);
				setResolvedFiles((prev) => new Set(prev).add(selectedFile));
			} catch (err) {
				setError(String(err));
			}
		},
		[workspacePath, selectedFile],
	);

	const handleComplete = useCallback(async () => {
		if (!workspacePath) return;

		try {
			await gitAddAll(workspacePath);
			await gitCommit(workspacePath, "resolve: コンフリクトを解消");
			await emit("conflict-resolved");
			await getCurrentWindow().close();
		} catch (err) {
			setError(String(err));
		}
	}, [workspacePath]);

	// If conflicts are already resolved (e.g. externally via CLI), emit and auto-close.
	// Do NOT auto-close when an error occurred (files may be empty due to fetch failure).
	useEffect(() => {
		if (loading || error || files.length > 0) return;
		void (async () => {
			await emit("conflict-resolved");
			await getCurrentWindow().close();
		})();
	}, [loading, error, files]);

	const allResolved = files.length > 0 && files.every((f) => resolvedFiles.has(f));

	if (loading) {
		return (
			<div className="flex h-screen items-center justify-center bg-bg-primary text-text-secondary">
				<p className="text-sm">読み込み中...</p>
			</div>
		);
	}

	if (files.length === 0) {
		return (
			<div className="flex h-screen flex-col items-center justify-center gap-2 bg-bg-primary text-text-secondary">
				{error ? (
					<p className="max-w-md px-4 text-center text-sm text-red-600 dark:text-red-400">
						{error}
					</p>
				) : (
					<p className="text-sm">コンフリクトファイルはありません</p>
				)}
			</div>
		);
	}

	return (
		<div className="flex h-screen flex-col bg-bg-primary text-text-primary">
			{error && (
				<div className="border-b border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-300">
					{error}
					<button
						type="button"
						onClick={() => setError(null)}
						className="ml-2 underline hover:no-underline"
					>
						閉じる
					</button>
				</div>
			)}
			<div className="flex min-h-0 flex-1">
				<div className="w-60 shrink-0 overflow-y-auto border-r border-border">
					<ConflictFileList
						files={files}
						resolvedFiles={resolvedFiles}
						selectedFile={selectedFile}
						onSelect={setSelectedFile}
					/>
				</div>
				<div className="min-w-0 flex-1">
					{selectedFile && conflictContent ? (
						<ConflictDiffView
							filePath={selectedFile}
							ours={conflictContent.ours}
							theirs={conflictContent.theirs}
							onResolve={handleResolve}
						/>
					) : selectedFile && resolvedFiles.has(selectedFile) ? (
						<div className="flex h-full items-center justify-center text-text-secondary">
							<p className="text-sm">このファイルは解決済みです</p>
						</div>
					) : (
						<div className="flex h-full items-center justify-center text-text-secondary">
							<p className="text-sm">ファイルを選択してください</p>
						</div>
					)}
				</div>
			</div>
			<div className="flex items-center justify-end border-t border-border px-4 py-3">
				<button
					type="button"
					onClick={handleComplete}
					disabled={!allResolved}
					className={`rounded px-4 py-1.5 text-sm font-medium text-white ${
						allResolved
							? "bg-green-600 hover:bg-green-700"
							: "cursor-not-allowed bg-gray-400 dark:bg-gray-600"
					}`}
				>
					完了
				</button>
			</div>
		</div>
	);
}
