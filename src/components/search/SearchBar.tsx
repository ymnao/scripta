import {
	findNext,
	findPrevious,
	getSearchQuery,
	replaceAll,
	replaceNext,
	SearchQuery,
	setSearchQuery,
} from "@codemirror/search";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { isIMEComposing } from "../../lib/ime";
import { IS_MAC, SHIFT_KEY_LABEL } from "../../lib/platform";
import { Tooltip } from "../common/Tooltip";

// keys は IS_MAC がモジュールロード時に確定するため、モジュールトップで定数化する。
const RETURN_KEY_LABEL = IS_MAC ? "↩" : "Enter";
const PREV_MATCH_KEYS = [SHIFT_KEY_LABEL, RETURN_KEY_LABEL];
const NEXT_MATCH_KEYS = [RETURN_KEY_LABEL];

export interface SearchBarHandle {
	focusInput: () => void;
	setSearch: (text: string) => void;
}

interface SearchBarProps {
	view: EditorView;
	// view.setState() で内部 state が完全置換されると view identity は同じでも
	// 検索クエリや listener compartment が消えるため、AppLayout 側で増分する
	// epoch を渡して effect を再実行させる (#220)。
	viewEpoch?: number;
	onClose: () => void;
	initialExpanded?: boolean;
	initialSearchText?: string;
	handleRef?: React.RefObject<SearchBarHandle | null>;
}

function countMatches(view: EditorView): { current: number; total: number } {
	const query = getSearchQuery(view.state);
	if (!query.valid) return { current: 0, total: 0 };
	const sq = new SearchQuery(query);
	const cursor = sq.getCursor(view.state);
	const sel = view.state.selection.main;
	let total = 0;
	let current = 0;
	let result = cursor.next();
	while (!result.done) {
		total++;
		if (total > 9999) return { current, total: 10000 };
		if (result.value.from === sel.from && result.value.to === sel.to) {
			current = total;
		}
		result = cursor.next();
	}
	return { current, total };
}

export function SearchBar({
	view,
	viewEpoch,
	onClose,
	initialExpanded = false,
	initialSearchText = "",
	handleRef,
}: SearchBarProps) {
	const [expanded, setExpanded] = useState(initialExpanded);
	const [searchText, setSearchText] = useState(initialSearchText);
	const [replaceText, setReplaceText] = useState("");
	const [matchInfo, setMatchInfo] = useState({ current: 0, total: 0 });
	const searchInputRef = useRef<HTMLInputElement>(null);
	const replaceInputRef = useRef<HTMLInputElement>(null);

	// Expose focus and setSearch to parent
	useImperativeHandle(handleRef, () => ({
		focusInput: () => {
			searchInputRef.current?.focus();
			searchInputRef.current?.select();
		},
		setSearch: (text: string) => {
			setSearchText(text);
			// Focus after state update
			requestAnimationFrame(() => {
				searchInputRef.current?.focus();
				searchInputRef.current?.select();
			});
		},
	}));

	// Focus search input on mount
	useEffect(() => {
		searchInputRef.current?.focus();
		searchInputRef.current?.select();
	}, []);

	// Focus replace input when expanded via toggle
	const prevExpandedRef = useRef(expanded);
	useEffect(() => {
		if (expanded && !prevExpandedRef.current) {
			replaceInputRef.current?.focus();
		}
		prevExpandedRef.current = expanded;
	}, [expanded]);

	// Sync search query to CodeMirror and update match count.
	// viewEpoch を deps に入れることで、view.setState() で内部 state が置換され
	// 検索クエリが消えた場合にも再 dispatch できる (#220)。effect body 内では
	// `void viewEpoch` で明示参照して biome に意図を伝える (再走 trigger 専用)。
	useEffect(() => {
		void viewEpoch;
		const query = new SearchQuery({ search: searchText, replace: replaceText });
		view.dispatch({ effects: setSearchQuery.of(query) });
		setMatchInfo(countMatches(view));
	}, [searchText, replaceText, view, viewEpoch]);

	// Listen to CM selection changes to update current match index.
	// view.setState() で compartment ごと state が消える可能性があるため、
	// effect ごとに新しい Compartment を作って毎回 appendConfig し直す。
	// cleanup は closure で同一 Compartment instance を参照するので確実に効く (#220)。
	// viewEpoch は effect body 内で `void viewEpoch` で明示参照して再走 trigger 専用と示す。
	useEffect(() => {
		void viewEpoch;
		const compartment = new Compartment();
		const ext = EditorView.updateListener.of((update) => {
			if (update.selectionSet) {
				setMatchInfo(countMatches(view));
			}
		});
		view.dispatch({
			effects: StateEffect.appendConfig.of(compartment.of(ext)),
		});
		return () => {
			view.dispatch({ effects: compartment.reconfigure([]) });
		};
	}, [view, viewEpoch]);

	const handleFindNext = useCallback(() => {
		if (!searchText) return;
		findNext(view);
		// Update after a tick to allow CM to process
		requestAnimationFrame(() => setMatchInfo(countMatches(view)));
	}, [view, searchText]);

	const handleFindPrevious = useCallback(() => {
		if (!searchText) return;
		findPrevious(view);
		requestAnimationFrame(() => setMatchInfo(countMatches(view)));
	}, [view, searchText]);

	const handleReplaceNext = useCallback(() => {
		if (!searchText) return;
		replaceNext(view);
		requestAnimationFrame(() => setMatchInfo(countMatches(view)));
	}, [view, searchText]);

	const handleReplaceAll = useCallback(() => {
		if (!searchText) return;
		replaceAll(view);
		requestAnimationFrame(() => setMatchInfo(countMatches(view)));
	}, [view, searchText]);

	const handleClose = useCallback(() => {
		// Clear search highlights
		view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
		onClose();
	}, [view, onClose]);

	const handleSearchKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (isIMEComposing(e)) return;
			if (e.key === "Enter") {
				e.preventDefault();
				if (e.shiftKey) {
					handleFindPrevious();
				} else {
					handleFindNext();
				}
			}
			if (e.key === "Escape") {
				e.preventDefault();
				handleClose();
			}
		},
		[handleFindNext, handleFindPrevious, handleClose],
	);

	const handleReplaceKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (isIMEComposing(e)) return;
			if (e.key === "Enter") {
				e.preventDefault();
				handleReplaceNext();
			}
			if (e.key === "Escape") {
				e.preventDefault();
				handleClose();
			}
		},
		[handleReplaceNext, handleClose],
	);

	const matchLabel =
		matchInfo.total === 0
			? "No results"
			: matchInfo.total >= 10000
				? "9999+"
				: matchInfo.current > 0
					? `${matchInfo.current} of ${matchInfo.total}`
					: `${matchInfo.total} results`;

	return (
		<search
			className="search-bar"
			aria-label="検索と置換"
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					handleClose();
				}
			}}
		>
			<div className="search-bar-row">
				<button
					type="button"
					className="search-bar-icon-btn"
					onClick={() => setExpanded((v) => !v)}
					aria-label={expanded ? "置換を閉じる" : "置換を開く"}
					aria-expanded={expanded}
				>
					{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				</button>

				<div className="search-bar-input-wrap">
					<input
						ref={searchInputRef}
						type="text"
						className="search-bar-input"
						placeholder="検索"
						aria-label="検索"
						value={searchText}
						onChange={(e) => setSearchText(e.target.value)}
						onKeyDown={handleSearchKeyDown}
					/>
					<span className="search-bar-match-count" aria-live="polite">
						{searchText ? matchLabel : ""}
					</span>
				</div>

				{/* disabled 属性は hover / focus イベントごと抑制して tooltip が出なくなるため、
				    aria-disabled + onClick ガードで無効状態を表現する（以下の置換系も同様） */}
				<Tooltip label="前の一致" keys={PREV_MATCH_KEYS} side="bottom">
					<button
						type="button"
						className="search-bar-icon-btn"
						onClick={matchInfo.total === 0 ? undefined : handleFindPrevious}
						aria-label="前の一致"
						aria-disabled={matchInfo.total === 0 || undefined}
					>
						<ArrowUp size={14} />
					</button>
				</Tooltip>
				<Tooltip label="次の一致" keys={NEXT_MATCH_KEYS} side="bottom">
					<button
						type="button"
						className="search-bar-icon-btn"
						onClick={matchInfo.total === 0 ? undefined : handleFindNext}
						aria-label="次の一致"
						aria-disabled={matchInfo.total === 0 || undefined}
					>
						<ArrowDown size={14} />
					</button>
				</Tooltip>
				<Tooltip label="検索を閉じる" keys={["Esc"]} side="bottom">
					<button
						type="button"
						className="search-bar-icon-btn"
						onClick={handleClose}
						aria-label="検索を閉じる"
					>
						<X size={14} />
					</button>
				</Tooltip>
			</div>

			{expanded && (
				<div className="search-bar-row search-bar-replace-row">
					<div className="search-bar-spacer" />
					<div className="search-bar-input-wrap">
						<input
							ref={replaceInputRef}
							type="text"
							className="search-bar-input"
							placeholder="置換"
							aria-label="置換"
							value={replaceText}
							onChange={(e) => setReplaceText(e.target.value)}
							onKeyDown={handleReplaceKeyDown}
						/>
					</div>
					<Tooltip label="置換" side="bottom">
						<button
							type="button"
							className="search-bar-icon-btn"
							onClick={matchInfo.total === 0 ? undefined : handleReplaceNext}
							aria-label="置換"
							aria-disabled={matchInfo.total === 0 || undefined}
						>
							<ReplaceIcon />
						</button>
					</Tooltip>
					<Tooltip label="すべて置換" side="bottom">
						<button
							type="button"
							className="search-bar-icon-btn"
							onClick={matchInfo.total === 0 ? undefined : handleReplaceAll}
							aria-label="すべて置換"
							aria-disabled={matchInfo.total === 0 || undefined}
						>
							<ReplaceAllIcon />
						</button>
					</Tooltip>
					<div className="search-bar-spacer" />
				</div>
			)}
		</search>
	);
}

/**
 * Replace icon: curved arrow flowing down to 1 line.
 * "Replace one occurrence"
 */
function ReplaceIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M2.5 3.5H10a2 2 0 0 1 2 2V9" />
			<path d="M10 7l2 2 2-2" />
			<path d="M2.5 12.5H13" />
		</svg>
	);
}

/**
 * Replace-all icon: curved arrow flowing down to 2 lines.
 * "Replace all occurrences"
 */
function ReplaceAllIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M2.5 2.5H10a2 2 0 0 1 2 2V7.5" />
			<path d="M10 5.5l2 2 2-2" />
			<path d="M2.5 10.5H13" />
			<path d="M2.5 13.5H13" />
		</svg>
	);
}
