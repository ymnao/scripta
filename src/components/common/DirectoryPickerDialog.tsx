import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { createFile, listDirectory, writeNewFile } from "../../lib/commands";
import { basename, joinPath, toRelativePath } from "../../lib/path";
import { buildInitialContent, useWikilinkStore } from "../../stores/wikilink";
import { useWorkspaceStore } from "../../stores/workspace";
import type { FileEntry } from "../../types/workspace";
import { DialogBase } from "./DialogBase";

function DirItem({
	entry,
	depth,
	selectedPath,
	onSelect,
}: {
	entry: FileEntry;
	depth: number;
	selectedPath: string;
	onSelect: (path: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const [children, setChildren] = useState<FileEntry[]>([]);
	const [loaded, setLoaded] = useState(false);
	const isSelected = entry.path === selectedPath;

	const handleClick = useCallback(() => {
		onSelect(entry.path);
		if (!loaded) {
			listDirectory(entry.path)
				.then((entries) => {
					setChildren(entries.filter((e) => e.isDirectory));
					setLoaded(true);
					setExpanded(true);
				})
				.catch((err) => {
					console.error("Failed to list directory:", err);
				});
		} else {
			setExpanded((prev) => !prev);
		}
	}, [entry.path, loaded, onSelect]);

	return (
		<li>
			<button
				type="button"
				className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm ${
					isSelected
						? "bg-black/10 text-text-primary dark:bg-white/10"
						: "text-text-primary hover:bg-bg-secondary"
				}`}
				style={{ paddingLeft: `${depth * 16 + 4}px` }}
				onClick={handleClick}
			>
				{expanded ? (
					<ChevronDown size={14} className="shrink-0 text-text-secondary" />
				) : (
					<ChevronRight size={14} className="shrink-0 text-text-secondary" />
				)}
				<Folder size={14} className="shrink-0 text-text-secondary" />
				<span className="truncate">{entry.name}</span>
			</button>
			{expanded && loaded && children.length > 0 && (
				<ul>
					{children.map((child) => (
						<DirItem
							key={child.path}
							entry={child}
							depth={depth + 1}
							selectedPath={selectedPath}
							onSelect={onSelect}
						/>
					))}
				</ul>
			)}
		</li>
	);
}

interface DirectoryPickerDialogProps {
	workspacePath: string;
}

export function DirectoryPickerDialog({ workspacePath }: DirectoryPickerDialogProps) {
	const titleId = useId();
	const createTarget = useWikilinkStore((s) => s.createTarget);
	const scanning = useWikilinkStore((s) => s.loading);
	const clearCreateTarget = useWikilinkStore((s) => s.clearCreateTarget);
	const bumpFileTreeVersion = useWorkspaceStore((s) => s.bumpFileTreeVersion);
	const navigateInTab = useWorkspaceStore((s) => s.navigateInTab);

	const open = createTarget !== null;
	const [selectedDir, setSelectedDir] = useState(workspacePath);
	const [rootChildren, setRootChildren] = useState<FileEntry[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [creating, setCreating] = useState(false);

	useEffect(() => {
		if (open) {
			setSelectedDir(workspacePath);
			setLoaded(false);
			setCreating(false);
			listDirectory(workspacePath)
				.then((entries) => {
					setRootChildren(entries.filter((e) => e.isDirectory));
					setLoaded(true);
				})
				.catch((err) => {
					console.error("Failed to list workspace directories:", err);
					setLoaded(true);
				});
		}
	}, [open, workspacePath]);

	const handleClose = useCallback(() => {
		clearCreateTarget();
	}, [clearCreateTarget]);

	const handleConfirm = useCallback(() => {
		if (!createTarget || creating) return;
		setCreating(true);

		const { pageName } = createTarget;
		const store = useWikilinkStore.getState();
		// スキャンがダイアログ表示後に完了している可能性があるため、最新の参照を取得
		const latestReferences =
			store.unresolvedLinks.find((l) => l.pageName === pageName)?.references ??
			createTarget.references;
		const filePath = joinPath(selectedDir, `${pageName}.md`);
		const draft = store.getDraft(pageName);
		const content = buildInitialContent(pageName, draft, latestReferences);
		const hasContent = draft || latestReferences.length > 0;

		const doCreate = hasContent ? writeNewFile(filePath, content) : createFile(filePath);

		doCreate
			.then(() => {
				bumpFileTreeVersion();
				navigateInTab(filePath);
				useWikilinkStore.getState().removeDraft(pageName);
				clearCreateTarget();
			})
			.catch((error) => {
				console.error("Failed to create file:", error);
				setCreating(false);
			});
	}, [createTarget, creating, selectedDir, bumpFileTreeVersion, navigateInTab, clearCreateTarget]);

	const fileName = createTarget ? `${createTarget.pageName}.md` : "";
	const previewPath = createTarget
		? toRelativePath(workspacePath, joinPath(selectedDir, fileName))
		: "";

	return (
		<DialogBase open={open} onClose={handleClose} ariaLabelledBy={titleId} size="sm" fixedHeight>
			<h2 id={titleId} className="shrink-0 text-sm font-semibold text-text-primary">
				作成先を選択
			</h2>
			<p className="mt-1 shrink-0 truncate text-xs text-text-secondary" title={previewPath}>
				{previewPath}
			</p>

			<div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded border border-border p-1">
				<div>
					<div>
						<button
							type="button"
							className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm ${
								selectedDir === workspacePath
									? "bg-black/10 text-text-primary dark:bg-white/10"
									: "text-text-primary hover:bg-bg-secondary"
							}`}
							onClick={() => setSelectedDir(workspacePath)}
						>
							<Folder size={14} className="shrink-0 text-text-secondary" />
							<span className="truncate">{basename(workspacePath) || workspacePath}</span>
							<span className="text-xs text-text-secondary">(ルート)</span>
						</button>
						{loaded && rootChildren.length > 0 && (
							<ul>
								{rootChildren.map((child) => (
									<DirItem
										key={child.path}
										entry={child}
										depth={1}
										selectedPath={selectedDir}
										onSelect={setSelectedDir}
									/>
								))}
							</ul>
						)}
					</div>
				</div>
			</div>

			<div className="mt-3 flex shrink-0 justify-end gap-2">
				<button
					type="button"
					onClick={handleClose}
					className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-secondary"
				>
					キャンセル
				</button>
				<button
					type="button"
					onClick={handleConfirm}
					disabled={creating || scanning}
					className="rounded-md bg-text-link px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
				>
					{scanning ? "スキャン中..." : "作成"}
				</button>
			</div>
		</DialogBase>
	);
}
