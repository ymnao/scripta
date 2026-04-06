import { Archive, FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { listDirectory, searchFilenames } from "../../lib/commands";
import { isIMEComposing } from "../../lib/ime";
import { basename } from "../../lib/path";
import { getScratchpadArchiveDir } from "../../lib/scripta-config";

interface CommandPaletteProps {
	open: boolean;
	workspacePath: string;
	onSelect: (filePath: string) => void;
	onClose: () => void;
}

export function CommandPalette({ open, workspacePath, onSelect, onClose }: CommandPaletteProps) {
	const [query, setQuery] = useState("");
	const [files, setFiles] = useState<string[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const requestIdRef = useRef(0);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (open) {
			setQuery("");
			setFiles([]);
			setSelectedIndex(0);
			setIsScratchpadMode(false);
			const id = ++requestIdRef.current;
			searchFilenames(workspacePath, "")
				.then((res) => {
					if (requestIdRef.current !== id) return;
					setFiles(res);
				})
				.catch(() => {
					if (requestIdRef.current !== id) return;
					setFiles([]);
				});
		}
	}, [open, workspacePath]);

	useEffect(() => {
		if (open) {
			requestAnimationFrame(() => {
				inputRef.current?.focus();
			});
		}
	}, [open]);

	const [isScratchpadMode, setIsScratchpadMode] = useState(false);

	const doSearch = useCallback(
		(q: string) => {
			const id = ++requestIdRef.current;

			if (q.startsWith("scratchpad:")) {
				setIsScratchpadMode(true);
				const archiveDir = getScratchpadArchiveDir(workspacePath);
				listDirectory(archiveDir)
					.then((entries) => {
						if (requestIdRef.current !== id) return;
						const filter = q.slice("scratchpad:".length).trim().toLowerCase();
						const paths = entries
							.filter((e) => !e.isDirectory && e.name.endsWith(".md"))
							.map((e) => e.path)
							.filter((p) => !filter || basename(p).toLowerCase().includes(filter))
							.reverse();
						setFiles(paths);
						setSelectedIndex(0);
					})
					.catch(() => {
						if (requestIdRef.current !== id) return;
						setFiles([]);
						setSelectedIndex(0);
					});
				return;
			}

			setIsScratchpadMode(false);
			searchFilenames(workspacePath, q)
				.then((res) => {
					if (requestIdRef.current !== id) return;
					setFiles(res);
					setSelectedIndex(0);
				})
				.catch(() => {
					if (requestIdRef.current !== id) return;
					setFiles([]);
					setSelectedIndex(0);
				});
		},
		[workspacePath],
	);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const value = e.target.value;
			setQuery(value);
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
			debounceRef.current = setTimeout(() => {
				doSearch(value);
			}, 200);
		},
		[doSearch],
	);

	useEffect(() => {
		return () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
			}
		};
	}, []);

	useEffect(() => {
		const item = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
		item?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (isIMEComposing(e)) return;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, files.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (files[selectedIndex]) {
					onSelect(files[selectedIndex]);
					onClose();
				}
			} else if (e.key === "Escape") {
				e.preventDefault();
				onClose();
			}
		},
		[files, selectedIndex, onSelect, onClose],
	);

	if (!open) return null;

	return createPortal(
		<div
			role="presentation"
			className="fixed inset-0 z-50 flex justify-center bg-black/30 pt-[15vh]"
			onMouseDown={onClose}
		>
			<div
				role="dialog"
				className="flex h-fit max-h-[60vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-bg-primary shadow-xl"
				onMouseDown={(e) => e.stopPropagation()}
				onKeyDown={handleKeyDown}
			>
				<div className="border-b border-border px-3 py-2">
					<input
						ref={inputRef}
						type="text"
						value={query}
						onChange={handleChange}
						placeholder="Search files by name..."
						aria-label="Search files by name"
						className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-secondary focus:outline-none"
					/>
				</div>
				<div ref={listRef} role="listbox" className="overflow-y-auto" aria-label="File results">
					{files.length === 0 && (
						<p className="px-3 py-2 text-xs text-text-secondary">No files found</p>
					)}
					{files.map((filePath, index) => (
						<button
							type="button"
							key={filePath}
							aria-current={index === selectedIndex}
							className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
								index === selectedIndex
									? "bg-blue-600/10 text-text-primary"
									: "text-text-primary hover:bg-black/5 dark:hover:bg-white/5"
							}`}
							onMouseEnter={() => setSelectedIndex(index)}
							onClick={() => {
								onSelect(filePath);
								onClose();
							}}
						>
							{isScratchpadMode ? (
								<Archive size={14} className="shrink-0 text-text-secondary" />
							) : (
								<FileText size={14} className="shrink-0 text-text-secondary" />
							)}
							<span className="min-w-0 truncate">{basename(filePath)}</span>
							<span className="ml-auto min-w-0 truncate text-xs text-text-secondary">
								{filePath}
							</span>
						</button>
					))}
				</div>
			</div>
		</div>,
		document.body,
	);
}
