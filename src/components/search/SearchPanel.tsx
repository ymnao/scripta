import { Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { searchFiles } from "../../lib/commands";
import { addTrailingSep } from "../../lib/path";
import type { SearchResult } from "../../types/search";

interface SearchPanelProps {
	workspacePath: string;
	onNavigate: (filePath: string, lineNumber: number, query: string) => void;
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
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const localInputRef = useRef<HTMLInputElement>(null);
	const ref = inputRef ?? localInputRef;
	const requestIdRef = useRef(0);

	useEffect(() => {
		if (!query.trim()) {
			requestIdRef.current++;
			setResults([]);
			setSearched(false);
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

		return () => clearTimeout(timer);
	}, [query, workspacePath, caseSensitive]);

	const toggleCollapse = useCallback((filePath: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(filePath)) {
				next.delete(filePath);
			} else {
				next.add(filePath);
			}
			return next;
		});
	}, []);

	const totalMatches = results.reduce((sum, g) => sum + g.matches.length, 0);

	return (
		<div className="flex h-full flex-col">
			<div className="search-panel-input-wrap">
				<Search size={13} className="search-panel-input-icon" />
				<input
					ref={ref}
					type="text"
					className="search-panel-input"
					placeholder="Search in files…"
					aria-label="Search in workspace"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<button
					type="button"
					className={`search-panel-option-btn ${caseSensitive ? "search-panel-option-btn-active" : ""}`}
					onClick={() => setCaseSensitive((v) => !v)}
					aria-label="Match case"
					aria-pressed={caseSensitive}
					title="Match case"
				>
					Aa
				</button>
			</div>

			<section className="search-panel-results" aria-label="Search results">
				{!searched && !query.trim() && (
					<p className="px-3 py-2 text-xs text-text-secondary">Type to search across all files</p>
				)}
				{searched && results.length === 0 && (
					<p className="px-3 py-2 text-xs text-text-secondary">No results</p>
				)}
				{searched && results.length > 0 && (
					<p className="px-3 py-1 text-xs text-text-secondary">
						{totalMatches} result{totalMatches !== 1 ? "s" : ""} in {results.length} file
						{results.length !== 1 ? "s" : ""}
					</p>
				)}
				{results.map((group) => (
					<div key={group.filePath}>
						<button
							type="button"
							className="search-panel-file-header"
							onClick={() => toggleCollapse(group.filePath)}
							aria-expanded={!collapsed.has(group.filePath)}
						>
							<span className="search-panel-file-chevron">
								{collapsed.has(group.filePath) ? "›" : "⌄"}
							</span>
							<span className="search-panel-file-name" title={group.relativePath}>
								{group.relativePath}
							</span>
							<span className="search-panel-file-count">{group.matches.length}</span>
						</button>
						{!collapsed.has(group.filePath) && (
							<div>
								{group.matches.map((match) => (
									<button
										type="button"
										key={`${match.filePath}-${match.lineNumber}-${match.matchStart}`}
										className="search-panel-match"
										onClick={() => onNavigate(match.filePath, match.lineNumber, query.trim())}
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
