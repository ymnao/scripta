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
import { searchFilenames } from "../../../lib/commands";
import { basename, joinPath, SEP_RE } from "../../../lib/path";
import { useWikilinkStore } from "../../../stores/wikilink";
import { useWorkspaceStore } from "../../../stores/workspace";
import { collectCursorLines, cursorInRange, cursorLinesChanged } from "./cursor-utils";
import { collectCodeRanges, isEscaped, overlapsCodeBlock } from "./math";

const WIKILINK_RE = /\[\[([^[\]\n\r]+)\]\]/g;

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

export function resolveWikilinkPath(pageName: string): string | null {
	const workspacePath = useWorkspaceStore.getState().workspacePath;
	if (!workspacePath) return null;

	// パストラバーサル防止: パス区切り文字・".."・"." を含む名前は拒否
	if (SEP_RE.test(pageName) || pageName === "." || pageName === ".." || pageName.includes("..")) {
		return null;
	}

	const fileName = pageName.toLowerCase().endsWith(".md") ? pageName : `${pageName}.md`;
	return joinPath(workspacePath, fileName);
}

export function buildFileMap(files: string[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const filePath of files) {
		const name = (filePath.split(/[/\\]/).pop() ?? "").replace(/\.md$/i, "");
		const key = name.normalize("NFC");
		if (!key) continue;
		const existing = map.get(key);
		if (!existing || filePath < existing) {
			map.set(key, filePath);
		}
	}
	return map;
}

export function buildDecorations(
	view: EditorView,
	fileMap: Map<string, string> | null,
): DecorationSet {
	const { state } = view;
	const tree = syntaxTree(state);

	const cursorLines = collectCursorLines(view);

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
			if (cursorInRange(cursorLines, startLine, endLine)) continue;

			const { page } = parseWikilink(match[1]);
			if (!page) continue;
			const stripped = page.toLowerCase().endsWith(".md") ? page.slice(0, -3) : page;
			const normalizedPage = stripped.normalize("NFC");
			const fileMapLoaded = fileMap !== null;
			const mapped = fileMapLoaded ? fileMap.get(normalizedPage) : undefined;
			// fileMap 未ロード時はフォールバックパスでの誤作成を防ぐため、デコレーションを作らない
			const resolvedPath = fileMapLoaded ? (mapped ?? resolveWikilinkPath(normalizedPage)) : null;
			if (!resolvedPath) continue;
			const exists = fileMapLoaded && mapped != null;

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
						role: "link",
						tabindex: "0",
						"aria-label": state.doc.sliceString(displayFrom, displayTo),
					},
				}).range(displayFrom, displayTo),
			);
		}
	}

	return Decoration.set(ranges, true);
}

function navigateWikilink(wikilinkEl: HTMLElement, view: EditorView) {
	const resolvedPath = wikilinkEl.dataset.wikilinkPath;
	if (!resolvedPath) return;
	const exists = wikilinkEl.dataset.wikilinkExists === "1";

	const { navigateInTab } = useWorkspaceStore.getState();
	if (!exists) {
		// ディレクトリ選択ダイアログ経由でファイルを作成
		const normalizedName = basename(resolvedPath).replace(/\.md$/i, "").normalize("NFC");
		const wikilinkState = useWikilinkStore.getState();
		const references =
			wikilinkState.unresolvedLinks.find((l) => l.pageName === normalizedName)?.references ?? [];
		wikilinkState.setCreateTarget(normalizedName, references);
	} else {
		navigateInTab(resolvedPath);
	}

	// Move cursor to the end of the wikilink decoration to avoid treating the wikilink itself as "active"
	const pos = view.posAtDOM(wikilinkEl);
	const plugin = view.plugin(wikilinkPlugin);
	if (plugin) {
		let endPos = -1;
		const iter = plugin.decorations.iter();
		while (iter.value) {
			if (iter.from <= pos && pos < iter.to) {
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
}

function createWikilinkClickHandler() {
	return EditorView.domEventHandlers({
		mousedown(event: MouseEvent, view: EditorView) {
			const target = event.target;
			if (!(target instanceof Element)) return false;
			const wikilinkEl = target.closest<HTMLElement>("[data-wikilink-path]");
			if (!wikilinkEl) return false;

			// 左クリック以外（右クリック・中クリック等）は標準動作を妨げない
			if (event.button !== 0) return false;

			event.preventDefault();
			navigateWikilink(wikilinkEl, view);
			return true;
		},
		keydown(event: KeyboardEvent, view: EditorView) {
			if (event.key !== "Enter" && event.key !== " ") return false;
			const target = event.target;
			if (!(target instanceof Element)) return false;
			const wikilinkEl = target.closest<HTMLElement>("[data-wikilink-path]");
			if (!wikilinkEl) return false;

			event.preventDefault();
			navigateWikilink(wikilinkEl, view);
			return true;
		},
	});
}

class WikilinkDecorationPlugin implements PluginValue {
	decorations: DecorationSet;
	prevCursorLines: Set<number>;
	fileMap: Map<string, string> | null = null;
	lastFileTreeVersion = -1;
	view: EditorView;
	destroyed = false;
	private pendingFileMapUpdate = false;
	private fetching = false;

	constructor(view: EditorView) {
		this.view = view;
		this.decorations = buildDecorations(view, this.fileMap);
		this.prevCursorLines = collectCursorLines(view);
		this.fetchFiles();
	}

	private fetchFiles() {
		if (this.fetching) return;
		const workspacePath = useWorkspaceStore.getState().workspacePath;
		if (!workspacePath) return;
		const currentVersion = useWorkspaceStore.getState().fileTreeVersion;
		this.fetching = true;
		searchFilenames(workspacePath, "")
			.then((files) => {
				this.fetching = false;
				if (this.destroyed) return;
				this.fileMap = buildFileMap(files);
				this.lastFileTreeVersion = currentVersion;
				this.pendingFileMapUpdate = true;
				this.view.dispatch({});
			})
			.catch((error) => {
				this.fetching = false;
				if (this.destroyed) return;
				// 失敗時も lastFileTreeVersion を進め、同一バージョンでの無制限リトライを防ぐ
				this.lastFileTreeVersion = currentVersion;
				console.error("[wikilinks] Failed to fetch filenames:", error);
			});
	}

	update(update: ViewUpdate) {
		this.view = update.view;

		// fileMap 更新時は composing 中でも即座にデコレーションを再構築する
		if (this.pendingFileMapUpdate) {
			this.pendingFileMapUpdate = false;
			this.decorations = buildDecorations(update.view, this.fileMap);
			this.prevCursorLines = collectCursorLines(update.view);
			// 一覧取得中に fileTreeVersion が進んでいた場合の取りこぼしを防ぐ
			const currentVersion = useWorkspaceStore.getState().fileTreeVersion;
			if (currentVersion !== this.lastFileTreeVersion) {
				this.fetchFiles();
			}
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

		const forceRebuild =
			update.docChanged ||
			update.viewportChanged ||
			syntaxTree(update.state) !== syntaxTree(update.startState);
		if (forceRebuild) {
			this.decorations = buildDecorations(update.view, this.fileMap);
			this.prevCursorLines = collectCursorLines(update.view);
		} else if (update.selectionSet || update.focusChanged) {
			const next = collectCursorLines(update.view);
			if (cursorLinesChanged(this.prevCursorLines, next)) {
				this.prevCursorLines = next;
				this.decorations = buildDecorations(update.view, this.fileMap);
			}
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
