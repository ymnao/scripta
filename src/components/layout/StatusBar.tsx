import {
	AlertTriangle,
	ArrowDown,
	ArrowUp,
	CircleHelp,
	GitBranch,
	GitCommitHorizontal,
	PanelLeft,
	Plus,
	Presentation,
	Settings,
	StickyNote,
	WifiOff,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { MOD_KEY_LABEL, SHIFT_KEY_LABEL } from "../../lib/platform";
import type { GitAction } from "../../types/git-sync";
import { Tooltip } from "../common/Tooltip";
import type { CursorInfo } from "../editor/MarkdownEditor";

export type SaveStatus = "saved" | "unsaved" | "saving" | "error" | "retrying";

interface StatusBarProps {
	saveStatus?: SaveStatus;
	cursorInfo?: CursorInfo;
	filePath?: string;
	onOpenSettings?: () => void;
	onOpenHelp?: () => void;
	gitAction?: GitAction;
	lastCommitTime?: string | null;
	hasConflicts?: boolean;
	offlineMode?: boolean;
	onGitSync?: () => void;
	onOpenConflictResolver?: () => void;
	gitReady?: boolean;
	onToggleScratchpad?: () => void;
	scratchpadOpen?: boolean;
	onToggleSlideView?: () => void;
	slideViewActive?: boolean;
	onToggleSidebar?: () => void;
	sidebarVisible?: boolean;
}

function GitSyncStatus({
	gitAction,
	lastCommitTime,
	hasConflicts,
	offlineMode,
	onGitSync,
	onOpenConflictResolver,
}: {
	gitAction: GitAction;
	lastCommitTime?: string | null;
	hasConflicts: boolean;
	offlineMode: boolean;
	onGitSync?: () => void;
	onOpenConflictResolver?: () => void;
}) {
	let icon: ReactNode;
	let label: string;

	if (hasConflicts) {
		icon = <AlertTriangle size={13} className="text-yellow-500" />;
		label = "コンフリクト";
	} else if (offlineMode) {
		icon = <WifiOff size={13} className="text-text-secondary" />;
		label = "オフライン";
	} else if (gitAction === "pull") {
		icon = <ArrowDown size={13} className="animate-pulse" />;
		label = "Pull 中...";
	} else if (gitAction === "push") {
		icon = <ArrowUp size={13} className="animate-pulse" />;
		label = "Push 中...";
	} else if (gitAction === "commit") {
		icon = <GitCommitHorizontal size={13} />;
		label = "コミット中...";
	} else if (gitAction === "add") {
		icon = <Plus size={13} />;
		label = "ステージング...";
	} else {
		icon = <GitBranch size={13} />;
		label = lastCommitTime ? lastCommitTime.slice(0, 16) : "";
	}

	return (
		<Tooltip label={hasConflicts ? "コンフリクト解消ウィンドウを開く" : "手動同期"}>
			<button
				type="button"
				onClick={hasConflicts ? onOpenConflictResolver : onGitSync}
				className="flex items-center gap-1 rounded px-1 hover:bg-black/10 dark:hover:bg-white/10"
				aria-label={hasConflicts ? "コンフリクト解消ウィンドウを開く" : "手動同期"}
			>
				{icon}
				{label && <span>{label}</span>}
			</button>
		</Tooltip>
	);
}

export function StatusBar({
	saveStatus,
	cursorInfo,
	filePath,
	onOpenSettings,
	onOpenHelp,
	gitAction,
	lastCommitTime,
	hasConflicts,
	offlineMode,
	onGitSync,
	onOpenConflictResolver,
	gitReady,
	onToggleScratchpad,
	scratchpadOpen,
	onToggleSlideView,
	slideViewActive,
	onToggleSidebar,
	sidebarVisible,
}: StatusBarProps) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef(0);

	useEffect(() => {
		return () => clearTimeout(timerRef.current);
	}, []);

	const handleCopyPath = useCallback(() => {
		if (!filePath || !navigator.clipboard) return;
		navigator.clipboard.writeText(filePath).then(
			() => {
				clearTimeout(timerRef.current);
				setCopied(true);
				timerRef.current = window.setTimeout(() => setCopied(false), 1500);
			},
			() => {},
		);
	}, [filePath]);

	return (
		<div className="flex h-6 items-center justify-between border-t border-border bg-bg-primary pl-2 pr-3 text-text-secondary">
			<div className="flex min-w-0 items-center gap-3 text-xs">
				{onToggleSidebar && (
					<Tooltip label="サイドバー" keys={[MOD_KEY_LABEL, "/"]}>
						<button
							type="button"
							onClick={onToggleSidebar}
							aria-label="サイドバー"
							aria-pressed={sidebarVisible}
							className={`flex items-center justify-center rounded p-0.5 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary dark:hover:bg-white/10 ${
								sidebarVisible ? "bg-black/10 text-text-primary dark:bg-white/10" : ""
							}`}
						>
							<PanelLeft size={15} />
						</button>
					</Tooltip>
				)}
				{gitReady && gitAction != null && (
					<GitSyncStatus
						gitAction={gitAction}
						lastCommitTime={lastCommitTime}
						hasConflicts={hasConflicts ?? false}
						offlineMode={offlineMode ?? false}
						onGitSync={onGitSync}
						onOpenConflictResolver={onOpenConflictResolver}
					/>
				)}
				{filePath && (
					<Tooltip label={filePath}>
						<button
							type="button"
							onClick={handleCopyPath}
							className="min-w-0 truncate rounded px-1 hover:bg-black/10 dark:hover:bg-white/10"
							data-testid="file-path"
						>
							{copied ? "コピーしました" : filePath}
						</button>
					</Tooltip>
				)}
			</div>
			<div className="flex items-center gap-3 text-xs">
				{cursorInfo && (
					<>
						{cursorInfo.selectedChars != null && cursorInfo.selectedLines != null ? (
							<span data-testid="selection-info">
								{cursorInfo.selectedLines} 行選択, {cursorInfo.selectedChars} 文字選択
							</span>
						) : (
							<span>
								{cursorInfo.line} 行, {cursorInfo.col} 列
							</span>
						)}
						<span>{cursorInfo.chars} 文字</span>
					</>
				)}
				<output className="shrink-0">
					{saveStatus === "unsaved" && "未保存"}
					{saveStatus === "saving" && "保存中..."}
					{saveStatus === "saved" && "保存済み"}
					{saveStatus === "error" && "保存失敗"}
					{saveStatus === "retrying" && "リトライ中..."}
				</output>
				{onToggleSlideView && (
					<Tooltip label="スライドビュー" keys={[MOD_KEY_LABEL, SHIFT_KEY_LABEL, "S"]}>
						<button
							type="button"
							onClick={onToggleSlideView}
							aria-label="スライドビュー"
							aria-pressed={slideViewActive}
							className={`flex items-center justify-center rounded p-0.5 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary dark:hover:bg-white/10 ${
								slideViewActive ? "bg-black/10 text-text-primary dark:bg-white/10" : ""
							}`}
						>
							<Presentation size={15} />
						</button>
					</Tooltip>
				)}
				{onToggleScratchpad && (
					<Tooltip label="スクラッチパッド" keys={[MOD_KEY_LABEL, "J"]}>
						<button
							type="button"
							onClick={onToggleScratchpad}
							aria-label="スクラッチパッド"
							aria-pressed={scratchpadOpen}
							className={`flex items-center justify-center rounded p-0.5 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary dark:hover:bg-white/10 ${
								scratchpadOpen ? "bg-black/10 text-text-primary dark:bg-white/10" : ""
							}`}
						>
							<StickyNote size={15} />
						</button>
					</Tooltip>
				)}
				<Tooltip label="設定" keys={[MOD_KEY_LABEL, ","]}>
					<button
						type="button"
						onClick={onOpenSettings}
						aria-label="設定を開く"
						className="flex items-center justify-center rounded p-0.5 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary dark:hover:bg-white/10"
					>
						<Settings size={15} />
					</button>
				</Tooltip>
				<Tooltip label="キーボードショートカット" keys={["F1"]}>
					<button
						type="button"
						onClick={onOpenHelp}
						aria-label="キーボードショートカット"
						className="flex items-center justify-center rounded p-0.5 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text-secondary dark:hover:bg-white/10"
					>
						<CircleHelp size={15} />
					</button>
				</Tooltip>
			</div>
		</div>
	);
}
