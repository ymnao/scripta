import {
	autocompletion,
	type Completion,
	type CompletionContext,
	type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { searchFilenames } from "../../../lib/commands";
import { useWorkspaceStore } from "../../../stores/workspace";

let cachedFiles: string[] = [];
let cachedVersion = -1;
let cachedWorkspacePath = "";
let fetchRequestId = 0;

export async function wikilinkCompletionSource(
	context: CompletionContext,
): Promise<CompletionResult | null> {
	const match = context.matchBefore(/\[\[([^\]\n\r|]*)/);
	if (!match) return null;

	const workspacePath = useWorkspaceStore.getState().workspacePath;
	if (!workspacePath) return null;

	const currentVersion = useWorkspaceStore.getState().fileTreeVersion;
	if (currentVersion !== cachedVersion || workspacePath !== cachedWorkspacePath) {
		const requestId = ++fetchRequestId;
		try {
			const files = await searchFilenames(workspacePath, "");
			// 後発リクエストが先に完了した場合、古い結果での上書きを防ぐ
			if (requestId !== fetchRequestId) return null;
			cachedFiles = files;
			cachedVersion = currentVersion;
			cachedWorkspacePath = workspacePath;
		} catch {
			if (requestId !== fetchRequestId) return null;
			cachedFiles = [];
			cachedVersion = -1;
			cachedWorkspacePath = "";
			return null;
		}
	}

	const query = match.text.slice(2).toLowerCase();
	const files = query ? cachedFiles.filter((f) => f.toLowerCase().includes(query)) : cachedFiles;

	const seen = new Set<string>();
	const options = files.flatMap((filePath) => {
		const fileName = filePath.split(/[/\\]/).pop()?.replace(/\.md$/i, "") ?? filePath;
		if (seen.has(fileName)) return [];
		seen.add(fileName);
		return [
			{
				label: fileName,
				detail: filePath,
				apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
					const after = view.state.doc.sliceString(to, to + 2);
					const skip = after === "]]" ? 2 : after.startsWith("]") ? 1 : 0;
					view.dispatch({
						changes: { from, to: to + skip, insert: `${fileName}]]` },
					});
				},
			},
		];
	});

	return { from: match.from + 2, options };
}

export const wikilinkCompletion: Extension = autocompletion({
	override: [wikilinkCompletionSource],
});
