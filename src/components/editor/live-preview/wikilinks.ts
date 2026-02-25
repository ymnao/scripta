import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type Extension, type Range } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
} from "@codemirror/view";
import { createFile, searchFilenames } from "../../../lib/commands";
import { useWorkspaceStore } from "../../../stores/workspace";
import { collectCodeRanges, isEscaped } from "./math";

const WIKILINK_RE = /\[\[([^\[\]]+)\]\]/g;

const hideBrackets = Decoration.replace({});

export function parseWikilink(content: string): { page: string; display: string } {
	const pipeIndex = content.indexOf("|");
	if (pipeIndex === -1) {
		return { page: content, display: content };
	}
	const page = content.slice(0, pipeIndex);
	const display = content.slice(pipeIndex + 1);
	return { page, display: display || page };
}

export function resolveWikilinkPath(pageName: string): string {
	const workspacePath = useWorkspaceStore.getState().workspacePath;
	if (!workspacePath) return pageName;

	const fileName = pageName.endsWith(".md") ? pageName : `${pageName}.md`;
	const lastSepIndex = Math.max(workspacePath.lastIndexOf("/"), workspacePath.lastIndexOf("\\"));
	const sep = lastSepIndex !== -1 ? workspacePath[lastSepIndex] : "/";
	return `${workspacePath}${sep}${fileName}`;
}

export function buildFileMap(files: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const filePath of files) {
		const basename = filePath.split(/[/\\]/).pop()?.replace(/\.md$/, "") ?? "";
		const key = basename.normalize("NFC");
		if (key && !map.has(key)) {
			map.set(key, filePath);
		}
	}
	return map;
}

function overlapsCodeBlock(
	from: number,
	to: number,
	codeRanges: { from: number; to: number }[],
): boolean {
	for (const range of codeRanges) {
		if (from < range.to && to > range.from) return true;
	}
	return false;
}

export function buildDecorations(view: EditorView, fileMap: Map<string, string>): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);

	const cursorLines = new Set<number>();
	if (view.hasFocus) {
		for (const range of state.selection.ranges) {
			const fromLine = state.doc.lineAt(range.from).number;
			const toLine = state.doc.lineAt(range.to).number;
			for (let l = fromLine; l <= toLine; l++) {
				cursorLines.add(l);
			}
		}
	}

	const ranges: Range<Decoration>[] = [];

	for (const { from, to } of view.visibleRanges) {
		const text = state.doc.sliceString(from, to);
		const codeRanges = collectCodeRanges(tree, from, to);

		for (const match of text.matchAll(WIKILINK_RE)) {
			const matchFrom = from + match.index;
			const matchTo = matchFrom + match[0].length;

			if (isEscaped(text, match.index)) continue;
			if (overlapsCodeBlock(matchFrom, matchTo, codeRanges)) continue;

			const startLine = state.doc.lineAt(matchFrom).number;
			const endLine = state.doc.lineAt(matchTo).number;
			let onCursorLine = false;
			for (let l = startLine; l <= endLine; l++) {
				if (cursorLines.has(l)) {
					onCursorLine = true;
					break;
				}
			}
			if (onCursorLine) continue;

			const { page, display } = parseWikilink(match[1]);
			const stripped = page.endsWith(".md") ? page.slice(0, -3) : page;
			const normalizedPage = stripped.normalize("NFC");
			const mapped = fileMap.get(normalizedPage);
			const resolvedPath = mapped ?? resolveWikilinkPath(page);
			const exists = mapped != null;

			// Hide [[ and ]]
			ranges.push(hideBrackets.range(matchFrom, matchFrom + 2));
			ranges.push(hideBrackets.range(matchTo - 2, matchTo));

			// If alias (page|display), also hide "page|" portion
			const pipeIndex = match[1].indexOf("|");
			const contentFrom = matchFrom + 2;
			const contentTo = matchTo - 2;
			const hasAlias = pipeIndex !== -1 && contentFrom + pipeIndex + 1 < contentTo;
			const emptyAlias = pipeIndex !== -1 && !hasAlias;
			let displayFrom: number;
			let displayTo = contentTo;

			if (hasAlias) {
				displayFrom = contentFrom + pipeIndex + 1;
				ranges.push(hideBrackets.range(contentFrom, displayFrom));
			} else if (emptyAlias) {
				// [[page|]] — hide trailing pipe, show page name
				displayFrom = contentFrom;
				displayTo = contentFrom + pipeIndex;
				ranges.push(hideBrackets.range(contentFrom + pipeIndex, contentTo));
			} else {
				displayFrom = contentFrom;
			}

			// Mark the display text with wikilink class + data attributes
			const markClass = exists ? "cm-wikilink" : "cm-wikilink cm-wikilink-missing";
			ranges.push(
				Decoration.mark({
					class: markClass,
					attributes: {
						"data-wikilink-path": resolvedPath,
						"data-wikilink-exists": exists ? "1" : "0",
					},
				}).range(displayFrom, displayTo),
			);
		}
	}

	return Decoration.set(ranges, true);
}

function createWikilinkClickHandler() {
	return EditorView.domEventHandlers({
		mousedown(event: MouseEvent, view: EditorView) {
			const target = event.target as HTMLElement;
			const wikilinkEl = target.closest<HTMLElement>("[data-wikilink-path]");
			if (!wikilinkEl) return false;

			event.preventDefault();
			event.stopPropagation();

			const resolvedPath = wikilinkEl.dataset.wikilinkPath;
			if (!resolvedPath) return true;
			const exists = wikilinkEl.dataset.wikilinkExists === "1";

			const { navigateInTab, bumpFileTreeVersion } = useWorkspaceStore.getState();
			if (!exists) {
				createFile(resolvedPath)
					.then(() => {
						bumpFileTreeVersion();
						navigateInTab(resolvedPath);
					})
					.catch((error) => {
						console.error("Failed to create wikilink target:", error);
					});
			} else {
				navigateInTab(resolvedPath);
			}

			// Place cursor after the wikilink so the line isn't "active"
			const pos = view.posAtDOM(wikilinkEl);
			const plugin = view.plugin(wikilinkPlugin);
			if (plugin) {
				let endPos = -1;
				const iter = plugin.decorations.iter();
				while (iter.value) {
					if (iter.from <= pos && pos <= iter.to) {
						endPos = iter.to;
						break;
					}
					if (iter.from > pos) break;
					iter.next();
				}
				if (endPos !== -1) {
					view.dispatch({ selection: EditorSelection.cursor(endPos) });
					view.focus();
				}
			}

			return true;
		},
	});
}

class WikilinkDecorationPlugin implements PluginValue {
	decorations: DecorationSet;
	fileMap: Map<string, string> = new Map();
	lastFileTreeVersion = -1;
	view: EditorView;
	destroyed = false;
	private pendingFileMapUpdate = false;

	constructor(view: EditorView) {
		this.view = view;
		this.decorations = buildDecorations(view, this.fileMap);
		this.fetchFiles();
	}

	private fetchFiles() {
		const workspacePath = useWorkspaceStore.getState().workspacePath;
		if (!workspacePath) return;
		searchFilenames(workspacePath, "")
			.then((files) => {
				if (this.destroyed) return;
				this.fileMap = buildFileMap(files);
				this.lastFileTreeVersion = useWorkspaceStore.getState().fileTreeVersion;
				this.pendingFileMapUpdate = true;
				this.view.dispatch();
			})
			.catch(() => {});
	}

	update(update: ViewUpdate) {
		this.view = update.view;

		// fileMap 更新時は composing 中でも即座にデコレーションを再構築する
		if (this.pendingFileMapUpdate) {
			this.pendingFileMapUpdate = false;
			this.decorations = buildDecorations(update.view, this.fileMap);
			return;
		}

		if (update.view.composing) {
			if (update.docChanged) this.decorations = this.decorations.map(update.changes);
			return;
		}

		const currentVersion = useWorkspaceStore.getState().fileTreeVersion;
		if (currentVersion !== this.lastFileTreeVersion) {
			this.fetchFiles();
		}

		if (
			update.docChanged ||
			update.viewportChanged ||
			update.selectionSet ||
			update.focusChanged ||
			update.geometryChanged ||
			syntaxTree(update.state) !== syntaxTree(update.startState)
		) {
			this.decorations = buildDecorations(update.view, this.fileMap);
		}
	}

	destroy() {
		this.destroyed = true;
	}
}

const wikilinkPlugin = ViewPlugin.fromClass(WikilinkDecorationPlugin, {
	decorations: (v) => v.decorations,
});

export const wikilinkDecoration: Extension = [wikilinkPlugin, createWikilinkClickHandler()];
