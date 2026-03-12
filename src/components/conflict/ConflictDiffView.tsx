interface ConflictDiffViewProps {
	filePath: string;
	ours: string;
	theirs: string;
	onResolve: (content: string) => void;
}

export function ConflictDiffView({ filePath, ours, theirs, onResolve }: ConflictDiffViewProps) {
	const fileName = filePath.split("/").pop() ?? filePath;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between border-b border-border px-4 py-2">
				<h3 className="text-sm font-medium text-text-primary">{fileName}</h3>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={() => onResolve(ours)}
						className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
					>
						Ours を採用
					</button>
					<button
						type="button"
						onClick={() => onResolve(theirs)}
						className="rounded bg-orange-600 px-3 py-1 text-sm font-medium text-white hover:bg-orange-700"
					>
						Theirs を採用
					</button>
				</div>
			</div>
			<div className="flex min-h-0 flex-1">
				<div className="flex-1 overflow-auto border-r border-border">
					<div className="px-3 py-2">
						<div className="mb-2 text-xs font-semibold text-blue-600 dark:text-blue-400">
							Ours (ローカル)
						</div>
						<pre className="whitespace-pre-wrap break-words text-sm text-text-primary">{ours}</pre>
					</div>
				</div>
				<div className="flex-1 overflow-auto">
					<div className="px-3 py-2">
						<div className="mb-2 text-xs font-semibold text-orange-600 dark:text-orange-400">
							Theirs (リモート)
						</div>
						<pre className="whitespace-pre-wrap break-words text-sm text-text-primary">
							{theirs}
						</pre>
					</div>
				</div>
			</div>
		</div>
	);
}
