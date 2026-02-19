import { useEffect, useState } from "react";
import { listDirectory } from "../../lib/commands";
import type { FileEntry } from "../../types/workspace";
import { FileTreeItem } from "./FileTreeItem";

interface FileTreeProps {
	workspacePath: string;
	selectedPath: string | null;
	onFileSelect: (path: string) => void;
}

export function FileTree({ workspacePath, selectedPath, onFileSelect }: FileTreeProps) {
	const [entries, setEntries] = useState<FileEntry[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let ignore = false;
		setError(null);
		setEntries([]);
		setLoading(true);
		listDirectory(workspacePath)
			.then((result) => {
				if (ignore) return;
				setEntries(result);
			})
			.catch((err) => {
				if (ignore) return;
				console.error("Failed to load workspace:", err);
				setError("Failed to load folder");
			})
			.finally(() => {
				if (ignore) return;
				setLoading(false);
			});
		return () => {
			ignore = true;
		};
	}, [workspacePath]);

	if (error) {
		return <p className="px-3 py-2 text-xs text-text-secondary">{error}</p>;
	}

	if (loading) {
		return <p className="px-3 py-2 text-xs text-text-secondary">Loading...</p>;
	}

	if (entries.length === 0) {
		return <p className="px-3 py-2 text-xs text-text-secondary">Empty folder</p>;
	}

	return (
		<ul role="tree" className="select-none overflow-y-auto px-1 py-1">
			{entries.map((entry) => (
				<FileTreeItem
					key={entry.path}
					entry={entry}
					depth={0}
					selectedPath={selectedPath}
					onFileSelect={onFileSelect}
				/>
			))}
		</ul>
	);
}
