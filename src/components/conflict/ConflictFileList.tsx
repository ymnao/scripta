import { Check, FileWarning } from "lucide-react";

interface ConflictFileListProps {
	files: string[];
	resolvedFiles: Set<string>;
	selectedFile: string | null;
	onSelect: (file: string) => void;
}

export function ConflictFileList({
	files,
	resolvedFiles,
	selectedFile,
	onSelect,
}: ConflictFileListProps) {
	return (
		<div className="flex flex-col gap-0.5 p-2">
			<h3 className="px-2 py-1 text-xs font-semibold text-text-secondary">
				コンフリクトファイル ({files.length})
			</h3>
			{files.map((file) => {
				const resolved = resolvedFiles.has(file);
				const selected = file === selectedFile;
				const fileName = file.split("/").pop() ?? file;
				return (
					<button
						key={file}
						type="button"
						onClick={() => onSelect(file)}
						className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
							selected
								? "bg-blue-600/15 text-blue-600 dark:bg-blue-400/15 dark:text-blue-400"
								: "text-text-primary hover:bg-black/5 dark:hover:bg-white/5"
						}`}
						title={file}
					>
						{resolved ? (
							<Check size={14} className="shrink-0 text-green-600 dark:text-green-400" />
						) : (
							<FileWarning size={14} className="shrink-0 text-yellow-500" />
						)}
						<span className="truncate">{fileName}</span>
					</button>
				);
			})}
		</div>
	);
}
