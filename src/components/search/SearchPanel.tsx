import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCollapseToggle } from "../../hooks/useCollapseToggle";
import { cancelSearch, searchFiles } from "../../lib/commands";
import { addTrailingSep } from "../../lib/path";
import type { SearchResult } from "../../types/search";

interface SearchPanelProps {
	workspacePath: string;
	onNavigate: (
		filePath: string,
		lineNumber: number,
		query: string,
		matchStart?: number,
		matchEnd?: number,
	) => void;
	inputRef?: React.RefObject<HTMLInputElement | null>;
}

interface GroupedResults {
	filePath: string;
	relativePath: string;
	matches: SearchResult[];
}

function groupByFile(results: SearchResult[], workspacePath: string): GroupedResults[] {
	const prefix = addTrailingSep(workspacePath);
	const map = new Map<string, GroupedResults>();
	for (const r of results) {
		let group = map.get(r.filePath);
		if (!group) {
			const rel = r.filePath.startsWith(prefix) ? r.filePath.slice(prefix.length) : r.filePath;
			group = { filePath: r.filePath, relativePath: rel, matches: [] };
			map.set(r.filePath, group);
		}
		group.matches.push(r);
	}
	return Array.from(map.values());
}

export function SearchPanel({ workspacePath, onNavigate, inputRef }: SearchPanelProps) {
	const [query, setQuery] = useState("");
	const [caseSensitive, setCaseSensitive] = useState(false);
	const [results, setResults] = useState<GroupedResults[]>([]);
	const [searched, setSearched] = useState(false);
	const { isCollapsed, toggle: toggleCollapse } = useCollapseToggle();
	const localInputRef = useRef<HTMLInputElement>(null);
	const ref = inputRef ?? localInputRef;
	const requestIdRef = useRef(0);

	useEffect(() => {
		if (!query.trim()) {
			requestIdRef.current++;
			setResults([]);
			setSearched(false);
			// 入力を全部消したときに in-flight の全文検索を main 側でも止める。
			// requestId だけでは renderer で結果を捨てるだけで、main の I/O は走り切る。
			cancelSearch().catch(() => {});
			return;
		}

		const id = ++requestIdRef.current;
		const timer = setTimeout(() => {
			searchFiles(workspacePath, query.trim(), caseSensitive ? true : undefined)
				.then((res) => {
					if (id !== requestIdRef.current) return;
					setResults(groupByFile(res, workspacePath));
					setSearched(true);
				})
				.catch((err) => {
					if (id !== requestIdRef.current) return;
					console.error("Search failed:", err);
					setResults([]);
					setSearched(true);
				});
		}, 300);

		return () => {
			clearTimeout(timer);
			// クエリ変更 / workspace 切替 / panel unmount で in-flight 検索を bail させる。
			// timer 未発火なら main 側に送る検索自体がないので no-op だが、発火後は必須。
			cancelSearch().catch(() => {});
		};
	}, [query, workspacePath, caseSensitive]);

	const totalMatches = results.reduce((sum, g) => sum + g.matches.length, 0);

	return (
		<div className="flex h-full flex-col">
			<div className="search-panel-input-wrap">
				<Search size={13} className="search-panel-input-icon" />
				<input
					ref={ref}
					type="text"
					className="search-panel-input"
					placeholder="ファイル内を検索…"
					aria-label="ワークスペース内を検索"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<button
					type="button"
					className={`search-panel-option-btn ${caseSensitive ? "search-panel-option-btn-active" : ""}`}
					onClick={() => setCaseSensitive((v) => !v)}
					aria-label="大文字/小文字を区別"
					aria-pressed={caseSensitive}
					title="大文字/小文字を区別"
				>
					Aa
				</button>
			</div>

			<section className="search-panel-results" aria-label="検索結果">
				{!searched && !query.trim() && (
					<p className="px-3 py-2 text-xs text-text-secondary">入力して全ファイルを検索</p>
				)}
				{searched && results.length === 0 && (
					<p className="px-3 py-2 text-xs text-text-secondary">結果なし</p>
				)}
				{searched && results.length > 0 && (
					<p className="px-3 py-1 text-xs text-text-secondary">
						{results.length} ファイル中 {totalMatches} 件
					</p>
				)}
				{results.map((group) => (
					<div key={group.filePath}>
						<button
							type="button"
							className="search-panel-file-header"
							onClick={() => toggleCollapse(group.filePath)}
							aria-expanded={!isCollapsed(group.filePath)}
						>
							<span className="search-panel-file-chevron">
								{isCollapsed(group.filePath) ? "›" : "⌄"}
							</span>
							<span className="search-panel-file-name" title={group.relativePath}>
								{group.relativePath}
							</span>
							<span className="search-panel-file-count">{group.matches.length}</span>
						</button>
						{!isCollapsed(group.filePath) && (
							<div>
								{group.matches.map((match) => (
									<button
										type="button"
										key={`${match.filePath}-${match.lineNumber}-${match.matchStart}`}
										className="search-panel-match"
										onClick={() =>
											onNavigate(
												match.filePath,
												match.lineNumber,
												query.trim(),
												match.matchStart,
												match.matchEnd,
											)
										}
									>
										<span className="search-panel-line-number">{match.lineNumber}</span>
										<span className="search-panel-line-content">
											<HighlightedLine
												line={match.lineContent}
												matchStart={match.matchStart}
												matchEnd={match.matchEnd}
											/>
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

function HighlightedLine({
	line,
	matchStart,
	matchEnd,
}: {
	line: string;
	matchStart: number;
	matchEnd: number;
}) {
	const before = line.slice(0, matchStart);
	const match = line.slice(matchStart, matchEnd);
	const after = line.slice(matchEnd);
	return (
		<>
			{before}
			<mark className="search-panel-highlight">{match}</mark>
			{after}
		</>
	);
}
