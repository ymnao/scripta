import {
	ArrowDownAZ,
	ArrowDownWideNarrow,
	ChevronDown,
	ChevronRight,
	FilePlus2,
	Link2Off,
	Loader2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toRelativePath } from "../../lib/path";
import { useWikilinkStore } from "../../stores/wikilink";
import { useWorkspaceStore } from "../../stores/workspace";
import type { UnresolvedWikilink } from "../../types/wikilink";

interface UnresolvedLinksPanelProps {
	workspacePath: string;
	onNavigate: (filePath: string, lineNumber: number, query: string) => void;
}

export function UnresolvedLinksPanel({ workspacePath, onNavigate }: UnresolvedLinksPanelProps) {
	const unresolvedLinks = useWikilinkStore((s) => s.unresolvedLinks);
	const loading = useWikilinkStore((s) => s.loading);
	const sortBy = useWikilinkStore((s) => s.sortBy);
	const scan = useWikilinkStore((s) => s.scan);
	const setSortBy = useWikilinkStore((s) => s.setSortBy);
	const setCreateTarget = useWikilinkStore((s) => s.setCreateTarget);
	const fileTreeVersion = useWorkspaceStore((s) => s.fileTreeVersion);
	const contentVersion = useWorkspaceStore((s) => s.contentVersion);

	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

	// ファイルツリー変更時は即座に再スキャン
	const scanVersion = fileTreeVersion;
	useEffect(() => {
		void scanVersion;
		void scan(workspacePath);
	}, [workspacePath, scanVersion, scan]);

	// ファイル保存時はデバウンスして再スキャン（編集内容の追従）
	const prevContentVersionRef = useRef(contentVersion);
	useEffect(() => {
		if (prevContentVersionRef.current === contentVersion) return;
		prevContentVersionRef.current = contentVersion;
		const timer = setTimeout(() => void scan(workspacePath), 2000);
		return () => clearTimeout(timer);
	}, [contentVersion, workspacePath, scan]);

	const sortedLinks = useMemo(() => {
		const links = [...unresolvedLinks];
		if (sortBy === "count") {
			links.sort(
				(a, b) => b.references.length - a.references.length || a.pageName.localeCompare(b.pageName),
			);
		}
		return links;
	}, [unresolvedLinks, sortBy]);

	const toggleCollapse = useCallback((pageName: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(pageName)) {
				next.delete(pageName);
			} else {
				next.add(pageName);
			}
			return next;
		});
	}, []);

	const handleCreate = useCallback(
		(link: UnresolvedWikilink) => {
			setCreateTarget(link.pageName, link.references);
		},
		[setCreateTarget],
	);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between px-3 py-1.5">
				<span className="text-xs text-text-secondary">
					{loading && sortedLinks.length === 0
						? "スキャン中..."
						: `${sortedLinks.length} 件の未解決リンク`}
				</span>
				<div className="flex items-center gap-0.5">
					<button
						type="button"
						onClick={() => setSortBy(sortBy === "name" ? "count" : "name")}
						aria-label={sortBy === "name" ? "Sort by reference count" : "Sort by name"}
						title={sortBy === "name" ? "参照数順" : "名前順"}
						className="rounded p-0.5 text-text-secondary hover:bg-black/10 dark:hover:bg-white/10"
					>
						{sortBy === "name" ? <ArrowDownWideNarrow size={13} /> : <ArrowDownAZ size={13} />}
					</button>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto" role="tree" aria-label="Unresolved wikilinks">
				{loading && sortedLinks.length === 0 && (
					<div className="flex items-center justify-center py-8">
						<Loader2 size={16} className="animate-spin text-text-secondary" />
					</div>
				)}
				{!loading && sortedLinks.length === 0 && (
					<p className="px-3 py-2 text-xs text-text-secondary">未解決のリンクはありません</p>
				)}
				{sortedLinks.map((link) => (
					<div key={link.pageName} role="treeitem" tabIndex={-1} className="group">
						<div className="flex items-center">
							<button
								type="button"
								className="search-panel-file-header min-w-0 flex-1"
								onClick={() => toggleCollapse(link.pageName)}
								aria-expanded={!collapsed.has(link.pageName)}
							>
								<span className="search-panel-file-chevron">
									{collapsed.has(link.pageName) ? (
										<ChevronRight size={12} />
									) : (
										<ChevronDown size={12} />
									)}
								</span>
								<Link2Off size={12} className="mr-1 shrink-0 text-text-secondary" />
								<span className="search-panel-file-name truncate" title={link.pageName}>
									{link.pageName}
								</span>
								<span className="search-panel-file-count">{link.references.length}</span>
							</button>
							<button
								type="button"
								onClick={() => handleCreate(link)}
								aria-label={`Create ${link.pageName}`}
								title="ファイルを作成"
								className="mr-1 shrink-0 rounded p-0.5 text-text-secondary opacity-0 transition-opacity hover:bg-black/10 group-hover:opacity-100 dark:hover:bg-white/10"
							>
								<FilePlus2 size={12} />
							</button>
						</div>
						{!collapsed.has(link.pageName) && (
							<div>
								{link.references.map((reference) => {
									const relativePath = toRelativePath(workspacePath, reference.filePath);
									return (
										<button
											type="button"
											key={`${reference.filePath}-${reference.lineNumber}`}
											className="search-panel-match"
											onClick={() => onNavigate(reference.filePath, reference.lineNumber, "")}
										>
											<span className="search-panel-line-number">{reference.lineNumber}</span>
											<span className="search-panel-line-content truncate" title={relativePath}>
												{relativePath}
											</span>
										</button>
									);
								})}
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
