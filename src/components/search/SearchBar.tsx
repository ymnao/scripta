import {
	SearchQuery,
	findNext,
	findPrevious,
	getSearchQuery,
	replaceAll,
	replaceNext,
	setSearchQuery,
} from "@codemirror/search";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { isIMEComposing } from "../../lib/ime";

export interface SearchBarHandle {
	focusInput: () => void;
	setSearch: (text: string) => void;
}

interface SearchBarProps {
	view: EditorView;
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

	// Sync search query to CodeMirror and update match count
	useEffect(() => {
		const query = new SearchQuery({ search: searchText, replace: replaceText });
		view.dispatch({ effects: setSearchQuery.of(query) });
		setMatchInfo(countMatches(view));
	}, [searchText, replaceText, view]);

	// Listen to CM selection changes to update current match index.
	// Use a ref-based Compartment so that re-runs reconfigure instead of appending.
	const compartmentRef = useRef(new Compartment());
	const appendedRef = useRef(false);
	useEffect(() => {
		const compartment = compartmentRef.current;
		const ext = EditorView.updateListener.of((update) => {
			if (update.selectionSet) {
				setMatchInfo(countMatches(view));
			}
		});
		if (appendedRef.current) {
			view.dispatch({ effects: compartment.reconfigure(ext) });
		} else {
			view.dispatch({
				effects: StateEffect.appendConfig.of(compartment.of(ext)),
			});
			appendedRef.current = true;
		}
		return () => {
			view.dispatch({ effects: compartment.reconfigure([]) });
		};
	}, [view]);

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
		<div
			className="search-bar"
			aria-label="Find and replace"
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
					aria-label={expanded ? "Collapse replace" : "Expand replace"}
					aria-expanded={expanded}
				>
					{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				</button>

				<div className="search-bar-input-wrap">
					<input
						ref={searchInputRef}
						type="text"
						className="search-bar-input"
						placeholder="Find"
						aria-label="Find"
						value={searchText}
						onChange={(e) => setSearchText(e.target.value)}
						onKeyDown={handleSearchKeyDown}
					/>
					<span className="search-bar-match-count" aria-live="polite">
						{searchText ? matchLabel : ""}
					</span>
				</div>

				<button
					type="button"
					className="search-bar-icon-btn"
					onClick={handleFindPrevious}
					aria-label="Previous match"
					disabled={matchInfo.total === 0}
				>
					<ArrowUp size={14} />
				</button>
				<button
					type="button"
					className="search-bar-icon-btn"
					onClick={handleFindNext}
					aria-label="Next match"
					disabled={matchInfo.total === 0}
				>
					<ArrowDown size={14} />
				</button>
				<button
					type="button"
					className="search-bar-icon-btn"
					onClick={handleClose}
					aria-label="Close search"
				>
					<X size={14} />
				</button>
			</div>

			{expanded && (
				<div className="search-bar-row search-bar-replace-row">
					<div className="search-bar-spacer" />
					<div className="search-bar-input-wrap">
						<input
							ref={replaceInputRef}
							type="text"
							className="search-bar-input"
							placeholder="Replace"
							aria-label="Replace"
							value={replaceText}
							onChange={(e) => setReplaceText(e.target.value)}
							onKeyDown={handleReplaceKeyDown}
						/>
					</div>
					<button
						type="button"
						className="search-bar-icon-btn"
						onClick={handleReplaceNext}
						aria-label="Replace"
						disabled={matchInfo.total === 0}
						title="Replace"
					>
						<ReplaceIcon />
					</button>
					<button
						type="button"
						className="search-bar-icon-btn"
						onClick={handleReplaceAll}
						aria-label="Replace all"
						disabled={matchInfo.total === 0}
						title="Replace all"
					>
						<ReplaceAllIcon />
					</button>
					<div className="search-bar-spacer" />
				</div>
			)}
		</div>
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
