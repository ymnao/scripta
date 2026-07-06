import { ChevronDown, ChevronRight, FileText, Loader2 } from "lucide-react";
import { useEffect, useMemo } from "react";
import { useCollapseToggle } from "../../hooks/useCollapseToggle";
import { useDebouncedVersionRescan } from "../../hooks/useDebouncedVersionRescan";
import { cancelBacklinkScan } from "../../lib/commands";
import { basename, isNewTabPath } from "../../lib/path";
import { useBacklinkStore } from "../../stores/backlink";
import { useWorkspaceStore } from "../../stores/workspace";

interface BacklinkPanelProps {
	workspacePath: string;
	onNavigate: (filePath: string, lineNumber: number, query: string) => void;
}

export function BacklinkPanel({ workspacePath, onNavigate }: BacklinkPanelProps) {
	const backlinks = useBacklinkStore((s) => s.backlinks);
	const loading = useBacklinkStore((s) => s.loading);
	const scan = useBacklinkStore((s) => s.scan);
	const reset = useBacklinkStore((s) => s.reset);
	const activeTabPath = useWorkspaceStore((s) => s.activeTabPath);

	const { isCollapsed, toggle: toggleCollapse, reset: resetCollapsed } = useCollapseToggle();

	// .md ファイル以外 (新規タブページなど) はバックリンク対象外。
	// main 側 walkMdFiles (electron/main/ipc/search.ts:28) が小文字 `.md` のみを
	// 収集対象にしているため、UI もそれに揃える (大文字拡張子は scan 対象外で
	// 結果が常に空になる)。
	const targetFilePath = useMemo(() => {
		if (!activeTabPath) return null;
		if (isNewTabPath(activeTabPath)) return null;
		if (!activeTabPath.endsWith(".md")) return null;
		return activeTabPath;
	}, [activeTabPath]);

	// onNavigate に渡す query。飛び先 source の `[[targetPage]]` を highlightQueryExtension の
	// case-insensitive substring で塗るため、scanBacklinksImpl と同じ正規化 (拡張子剥がし + NFC)
	// で算出する (electron/main/ipc/search.ts:509-513 と同方針)。
	// 早期 return より前で hook を呼ぶ必要があるため、targetFilePath が null の場合は
	// "" を返す (その場合 panel は早期 return され、targetPageName は読まれない)。
	const targetPageName = useMemo(
		() => (targetFilePath ? basename(targetFilePath).slice(0, -3).normalize("NFC") : ""),
		[targetFilePath],
	);

	// ターゲット / workspace 変更時 (と mount 時) は即座に再スキャン。
	// targetFilePath が null になったら store を reset して古い結果を残さない。
	// fileTreeVersion / contentVersion 起点の再スキャンは useDebouncedVersionRescan が担当 (#298)。
	useEffect(() => {
		if (!targetFilePath) {
			reset();
			return;
		}
		void scan(workspacePath, targetFilePath);
		return () => {
			// workspace 切替 / panel unmount で in-flight scan を main 側でも止める。
			cancelBacklinkScan().catch(() => {});
		};
	}, [workspacePath, targetFilePath, scan, reset]);

	// ターゲットノートが切り替わったら、前の対象で残っていた折り畳み状態を捨てる。
	// sourceFile path が偶然同名で衝突した場合に古い open/closed 状態を引き継いで
	// ユーザーが混乱するのを防ぐ。
	//
	// deps: `targetFilePath` は本 effect の trigger (値は body 内で参照しないため
	// `void` で読み込みを明示)、`resetCollapsed` は useCollapseToggle が
	// useCallback([]) で安定参照を保証するため body 内で呼び出すだけ。後者を消して
	// しまうと将来 hook の memoize が外れた際 stale closure になるため、両方とも deps
	// に積む。
	useEffect(() => {
		void targetFilePath;
		resetCollapsed();
	}, [targetFilePath, resetCollapsed]);

	// ファイルツリー変更 / ファイル保存時はデバウンスして再スキャン（編集内容の追従、#298）。
	// inline arrow を渡すと毎レンダリングで effect が再実行され timer が壊れるため、
	// useMemo で identity を安定させる。
	const rescan = useMemo(
		() => (targetFilePath ? () => void scan(workspacePath, targetFilePath) : null),
		[workspacePath, targetFilePath, scan],
	);
	useDebouncedVersionRescan(rescan, cancelBacklinkScan);

	if (!targetFilePath) {
		return (
			<div className="flex h-full flex-col">
				<p className="px-3 py-2 text-xs text-text-secondary">
					バックリンクを表示するには Markdown ファイルを開いてください
				</p>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between px-3 py-1.5">
				<span className="text-xs text-text-secondary">
					{loading && backlinks.length === 0
						? "スキャン中..."
						: `${backlinks.length} 件のバックリンク`}
				</span>
			</div>

			<section className="flex-1 overflow-y-auto" aria-label="バックリンク">
				{loading && backlinks.length === 0 && (
					<div className="flex items-center justify-center py-8">
						<Loader2 size={16} className="animate-spin text-text-secondary" />
					</div>
				)}
				{!loading && backlinks.length === 0 && (
					<p className="px-3 py-2 text-xs text-text-secondary">バックリンクはありません</p>
				)}
				{backlinks.map((src) => (
					<div key={src.sourceFile} className="group">
						<div className="flex items-center">
							<button
								type="button"
								className="search-panel-file-header min-w-0 flex-1"
								onClick={() => toggleCollapse(src.sourceFile)}
								aria-expanded={!isCollapsed(src.sourceFile)}
							>
								<span className="search-panel-file-chevron">
									{isCollapsed(src.sourceFile) ? (
										<ChevronRight size={12} />
									) : (
										<ChevronDown size={12} />
									)}
								</span>
								<FileText size={12} className="mr-1 shrink-0 text-text-secondary" />
								<span className="search-panel-file-name truncate" title={src.displayPath}>
									{src.displayName}
								</span>
								<span className="search-panel-file-count">{src.references.length}</span>
							</button>
						</div>
						{!isCollapsed(src.sourceFile) && (
							<div>
								{src.references.map((reference) => (
									<button
										type="button"
										key={`${reference.filePath}-${reference.lineNumber}-${reference.byteOffset}`}
										className="search-panel-match"
										onClick={() =>
											onNavigate(reference.filePath, reference.lineNumber, targetPageName)
										}
									>
										<span className="search-panel-line-number">{reference.lineNumber}</span>
										<span
											className="search-panel-line-content truncate"
											title={reference.lineContent}
										>
											{reference.lineContent}
										</span>
									</button>
								))}
							</div>
						)}
					</div>
				))}
			</section>
		</div>
	);
}
