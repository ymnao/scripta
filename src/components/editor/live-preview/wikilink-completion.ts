import {
	type CompletionContext,
	type CompletionResult,
	autocompletion,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { searchFilenames } from "../../../lib/commands";
import { useWorkspaceStore } from "../../../stores/workspace";

let cachedFiles: string[] = [];
let cachedVersion = -1;
let cachedWorkspacePath = "";

export async function wikilinkCompletionSource(
	context: CompletionContext,
): Promise<CompletionResult | null> {
	const match = context.matchBefore(/\[\[([^\]]*)/);
	if (!match) return null;

	const workspacePath = useWorkspaceStore.getState().workspacePath;
	if (!workspacePath) return null;

	const currentVersion = useWorkspaceStore.getState().fileTreeVersion;
	if (currentVersion !== cachedVersion || workspacePath !== cachedWorkspacePath) {
		cachedFiles = await searchFilenames(workspacePath, "");
		cachedVersion = currentVersion;
		cachedWorkspacePath = workspacePath;
	}

	const query = match.text.slice(2).toLowerCase();
	const files = query ? cachedFiles.filter((f) => f.toLowerCase().includes(query)) : cachedFiles;

	return {
		from: match.from + 2,
		options: files.map((filePath) => {
			const fileName = filePath.split(/[/\\]/).pop()?.replace(/\.md$/, "") ?? filePath;
			return {
				label: fileName,
				detail: filePath,
				apply: (view, _completion, from, to) => {
					const after = view.state.doc.sliceString(to, to + 2);
					const skip = after === "]]" ? 2 : after.startsWith("]") ? 1 : 0;
					view.dispatch({
						changes: { from, to: to + skip, insert: `${fileName}]]` },
					});
				},
			};
		}),
	};
}

export const wikilinkCompletion: Extension = autocompletion({
	override: [wikilinkCompletionSource],
});
