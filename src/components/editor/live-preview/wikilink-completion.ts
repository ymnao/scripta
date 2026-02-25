import {
	type CompletionContext,
	type CompletionResult,
	autocompletion,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { searchFilenames } from "../../../lib/commands";
import { useWorkspaceStore } from "../../../stores/workspace";

async function wikilinkCompletionSource(
	context: CompletionContext,
): Promise<CompletionResult | null> {
	const match = context.matchBefore(/\[\[([^\]]*)/);
	if (!match) return null;

	const workspacePath = useWorkspaceStore.getState().workspacePath;
	if (!workspacePath) return null;

	const query = match.text.slice(2);
	const files = await searchFilenames(workspacePath, query);

	return {
		from: match.from + 2,
		options: files.map((filePath) => {
			const fileName = filePath.split(/[/\\]/).pop()?.replace(/\.md$/, "") ?? filePath;
			return {
				label: fileName,
				detail: filePath,
				apply: (view, _completion, from, to) => {
					const after = view.state.doc.sliceString(to, to + 2);
					const skip = after === "]]" ? 2 : after[0] === "]" ? 1 : 0;
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
