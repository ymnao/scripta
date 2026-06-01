import type { Page } from "@playwright/test";
import type { Api, MenuEventName, SaveDialogOptions } from "../../electron/preload/api";
import type { ConflictContent, GitStatus, SyncMethod } from "../../src/types/git-sync";
import type { OgpData } from "../../src/types/ogp";
import type { SearchResult } from "../../src/types/search";
import type { UpdateInfo } from "../../src/types/update";
import type { UnresolvedWikilink } from "../../src/types/wikilink";
import type { FileEntry, FsChangeEvent } from "../../src/types/workspace";

// renderer-only Playwright で `window.api` を addInitScript 注入するモック。
// 旧 Tauri 版 `tauri-mock.ts` の Electron 移植版（参考: /Users/nakiym/development/tools/scripta/e2e/helpers/tauri-mock.ts）。

export interface MockFileSystem {
	files: Record<string, string>;
	directories: Record<string, FileEntry[]>;
}

export interface ElectronApiMockOptions {
	/** 初期ファイル / ディレクトリツリー */
	fs?: MockFileSystem;
	/** `openDirectoryPicker` が返すパス（null = キャンセル） */
	dialogResult?: string | null;
	/** `showSaveDialog` が返すパス（null = キャンセル） */
	saveDialogResult?: string | null;
	/** 初期 settings 値（settingsGet で読み出される） */
	settings?: Record<string, unknown>;
	/** `getAppVersion` が返すバージョン文字列（既定: "0.0.0-e2e"） */
	appVersion?: string;
}

interface MockStore {
	files: Record<string, string>;
	directories: Record<string, FileEntry[]>;
	settings: Record<string, unknown>;
	dialogResult: string | null;
	saveDialogResult: string | null;
	appVersion: string;
	calls: Record<string, unknown[][]>;
	fsListeners: Array<(events: FsChangeEvent[]) => void>;
	menuListeners: Record<string, Array<() => void>>;
	closeListeners: Array<() => void | Promise<void>>;
	conflictListeners: Array<(workspacePath: string) => void>;
	activeWorkspace: string | null;
}

declare global {
	interface Window {
		__E2E_API_MOCK__?: MockStore;
	}
}

export class ElectronApiMock {
	private page: Page;

	constructor(page: Page) {
		this.page = page;
	}

	async setup(opts: ElectronApiMockOptions = {}): Promise<void> {
		const payload: Required<ElectronApiMockOptions> = {
			fs: opts.fs ?? { files: {}, directories: {} },
			dialogResult: opts.dialogResult ?? null,
			saveDialogResult: opts.saveDialogResult ?? null,
			settings: opts.settings ?? {},
			appVersion: opts.appVersion ?? "0.0.0-e2e",
		};
		await this.page.addInitScript(installApiMock, payload);
	}

	async getCalls(method: string): Promise<unknown[][]> {
		return this.page.evaluate((m: string) => {
			return window.__E2E_API_MOCK__?.calls[m] ?? [];
		}, method);
	}

	async clearCalls(method?: string): Promise<void> {
		await this.page.evaluate((m: string | undefined) => {
			const store = window.__E2E_API_MOCK__;
			if (!store) return;
			if (m) {
				store.calls[m] = [];
			} else {
				store.calls = {};
			}
		}, method);
	}

	async setFileContent(path: string, content: string): Promise<void> {
		await this.page.evaluate(
			({ path: p, content: c }: { path: string; content: string }) => {
				const store = window.__E2E_API_MOCK__;
				if (store) store.files[p] = c;
			},
			{ path, content },
		);
	}

	async addFiles(fs: MockFileSystem): Promise<void> {
		await this.page.evaluate((data: MockFileSystem) => {
			const store = window.__E2E_API_MOCK__;
			if (!store) return;
			Object.assign(store.files, data.files);
			for (const [dir, entries] of Object.entries(data.directories)) {
				store.directories[dir] = [...(store.directories[dir] ?? []), ...entries];
			}
		}, fs);
	}

	async setDialogResult(path: string | null): Promise<void> {
		await this.page.evaluate((p: string | null) => {
			const store = window.__E2E_API_MOCK__;
			if (store) store.dialogResult = p;
		}, path);
	}

	async setSaveDialogResult(path: string | null): Promise<void> {
		await this.page.evaluate((p: string | null) => {
			const store = window.__E2E_API_MOCK__;
			if (store) store.saveDialogResult = p;
		}, path);
	}

	async simulateFs(events: FsChangeEvent[]): Promise<void> {
		await this.page.evaluate((evs: FsChangeEvent[]) => {
			const store = window.__E2E_API_MOCK__;
			if (!store) return;
			for (const ln of store.fsListeners) ln(evs);
		}, events);
	}

	/** ファイル作成 + create イベントを連動して発火（外部 fs 変更の再現） */
	async simulateFileCreate(
		filePath: string,
		content: string,
		parentDir: string,
		fileName: string,
	): Promise<void> {
		await this.page.evaluate(
			(args: { filePath: string; content: string; parentDir: string; fileName: string }) => {
				const store = window.__E2E_API_MOCK__;
				if (!store) return;
				store.files[args.filePath] = args.content;
				const parent = store.directories[args.parentDir];
				if (parent) {
					parent.push({ name: args.fileName, path: args.filePath, isDirectory: false });
				}
				const evs = [{ kind: "create" as const, path: args.filePath }];
				for (const ln of store.fsListeners) ln(evs);
			},
			{ filePath, content, parentDir, fileName },
		);
	}

	/** ファイル更新 + modify イベントを連動 */
	async simulateFileModify(filePath: string, newContent: string): Promise<void> {
		await this.page.evaluate(
			(args: { filePath: string; newContent: string }) => {
				const store = window.__E2E_API_MOCK__;
				if (!store) return;
				store.files[args.filePath] = args.newContent;
				const evs = [{ kind: "modify" as const, path: args.filePath }];
				for (const ln of store.fsListeners) ln(evs);
			},
			{ filePath, newContent },
		);
	}

	/** ファイル削除 + delete イベントを連動 */
	async simulateFileDelete(filePath: string, parentDir: string, fileName: string): Promise<void> {
		await this.page.evaluate(
			(args: { filePath: string; parentDir: string; fileName: string }) => {
				const store = window.__E2E_API_MOCK__;
				if (!store) return;
				delete store.files[args.filePath];
				const parent = store.directories[args.parentDir];
				if (parent) {
					store.directories[args.parentDir] = parent.filter((e) => e.name !== args.fileName);
				}
				const evs = [{ kind: "delete" as const, path: args.filePath }];
				for (const ln of store.fsListeners) ln(evs);
			},
			{ filePath, parentDir, fileName },
		);
	}

	async emitMenuEvent(name: MenuEventName): Promise<void> {
		await this.page.evaluate((n: string) => {
			const store = window.__E2E_API_MOCK__;
			if (!store) return;
			for (const ln of store.menuListeners[n] ?? []) ln();
		}, name);
	}
}

export const modKey = process.platform === "darwin" ? "Meta" : "Control";

// addInitScript の callback は page (browser) コンテキストで serialize 評価される。
// この関数の外側の変数 / import は実行時参照不可、payload は serializable に閉じる。
function installApiMock(opts: {
	fs: { files: Record<string, string>; directories: Record<string, FileEntry[]> };
	dialogResult: string | null;
	saveDialogResult: string | null;
	settings: Record<string, unknown>;
	appVersion: string;
}): void {
	const store: MockStore = {
		files: { ...opts.fs.files },
		directories: { ...opts.fs.directories },
		settings: { ...opts.settings },
		dialogResult: opts.dialogResult,
		saveDialogResult: opts.saveDialogResult,
		appVersion: opts.appVersion,
		calls: {},
		fsListeners: [],
		menuListeners: {},
		closeListeners: [],
		conflictListeners: [],
		activeWorkspace: null,
	};
	window.__E2E_API_MOCK__ = store;

	const track = (name: string, args: unknown[]): void => {
		const list = store.calls[name] ?? [];
		list.push(args);
		store.calls[name] = list;
	};

	const collectMdFiles = (dirPath: string): string[] => {
		const out: string[] = [];
		const entries = store.directories[dirPath] ?? [];
		for (const e of entries) {
			// 本番 (electron/main/ipc/search.ts:19) と同じく `.` 始まりは早期 skip。
			// `.git` / `.scripta` 等の隠しディレクトリの中身は再帰しない。
			if (e.name.startsWith(".")) continue;
			if (e.isDirectory) out.push(...collectMdFiles(e.path));
			else if (e.name.endsWith(".md")) out.push(e.path);
		}
		return out;
	};

	// pageName / filePath を byte 比較で昇順する（本番 search.ts:106 / 158 / 247 と一致）。
	// localeCompare はロケール依存で順序がズレる。
	const byteCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

	// 本番 fuzzyMatch (search.ts:45-57) と同じ two-pointer 走査。
	const fuzzyMatch = (query: string, target: string): boolean => {
		const q = query.toLowerCase();
		const t = target.toLowerCase();
		if (q.length === 0) return true;
		let qi = 0;
		for (const ch of t) {
			if (ch === q[qi]) {
				qi++;
				if (qi === q.length) return true;
			}
		}
		return qi === q.length;
	};

	// 本番 electron/main/utils/search-pure.ts の inline コピー。
	// addInitScript 制約で import 不可、ロジックを 1:1 で複製する。
	// `İ` (U+0130) → `i̇` のように toLowerCase で長さが変わる文字を含む行で、
	// lower 側の indexOf 結果を元行の UTF-16 offset に逆引きする必要がある。
	const isAsciiOnly = (text: string): boolean => {
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) > 127) return false;
		}
		return true;
	};
	const buildLowerToOrigUtf16Map = (text: string): number[] | null => {
		if (isAsciiOnly(text)) return null;
		const map: number[] = [];
		let origOffset = 0;
		for (const ch of text) {
			const origLen = ch.length;
			const lowerLen = ch.toLowerCase().length;
			for (let i = 0; i < lowerLen; i++) {
				map.push(origOffset);
			}
			origOffset += origLen;
		}
		map.push(origOffset);
		return map;
	};

	const parentDir = (path: string): string => {
		const i = path.lastIndexOf("/");
		return i < 0 ? "" : path.slice(0, i);
	};
	const baseName = (path: string): string => {
		const i = path.lastIndexOf("/");
		return i < 0 ? path : path.slice(i + 1);
	};

	// `Api` 型に固定することで preload 契約と乖離した瞬間に typecheck が落ちる。
	// 緩い `unknown` / `string` のままだと preload 側のシグネチャが変わっても
	// この helper は静かに古いまま放置されるため、foundation として固定する。
	const api: Api = {
		getAppVersion: async (): Promise<string> => {
			track("getAppVersion", []);
			return store.appVersion;
		},
		closeWindow: async (): Promise<void> => {
			track("closeWindow", []);
		},
		openConflictWindow: async (workspacePath: string): Promise<void> => {
			track("openConflictWindow", [workspacePath]);
		},
		onWindowCloseRequested: (cb: () => void | Promise<void>): (() => void) => {
			store.closeListeners.push(cb);
			return () => {
				store.closeListeners = store.closeListeners.filter((x) => x !== cb);
			};
		},
		clearWebviewBrowsingData: async (): Promise<void> => {
			track("clearWebviewBrowsingData", []);
		},

		openExternal: async (url: string): Promise<void> => {
			track("openExternal", [url]);
		},
		showInFolder: async (path: string): Promise<void> => {
			track("showInFolder", [path]);
		},
		// canonical: electron/preload/scripta-asset-url.ts の buildScriptaAssetUrl
		// （addInitScript 制約で import 不可なのでロジックを 1:1 で複製）
		buildAssetUrl: (path: string): string => {
			const normalized = path.replace(/\\/g, "/");
			const withLeading = normalized.startsWith("/") ? normalized : `/${normalized}`;
			const encoded = withLeading.split("/").map(encodeURIComponent).join("/");
			return `scripta-asset://localhost${encoded}`;
		},

		openDirectoryPicker: async (): Promise<string | null> => {
			track("openDirectoryPicker", []);
			return store.dialogResult;
		},
		showSaveDialog: async (opts: SaveDialogOptions): Promise<string | null> => {
			track("showSaveDialog", [opts]);
			return store.saveDialogResult;
		},

		workspaceSet: async (path: string | null): Promise<void> => {
			track("workspaceSet", [path]);
			store.activeWorkspace = path;
			// 本番 electron/main/ipc/workspace.ts:104 と settings.ts:170 は
			// `persistWorkspacePath(path)` で settings の workspacePath まで永続化する
			// (path === null は delete、それ以外は set)。startup の loadSettings →
			// AppLayout は settings.workspacePath を読んで workspace を復元するため、
			// 永続化を再現しないと「reload で workspace が復元されない」差異が出る。
			if (path === null) {
				delete store.settings.workspacePath;
			} else {
				store.settings.workspacePath = path;
			}
		},

		readFile: async (path: string): Promise<string> => {
			track("readFile", [path]);
			if (path in store.files) return store.files[path];
			throw new Error(`File not found: ${path}`);
		},
		writeFile: async (path: string, content: string): Promise<void> => {
			track("writeFile", [path, content]);
			store.files[path] = content;
		},
		writeNewFile: async (path: string, content: string): Promise<void> => {
			track("writeNewFile", [path, content]);
			if (path in store.files) throw new Error(`Already exists: ${path}`);
			store.files[path] = content;
			const parent = parentDir(path);
			if (parent in store.directories) {
				store.directories[parent].push({ name: baseName(path), path, isDirectory: false });
			}
		},
		listDirectory: async (
			path: string,
			opts?: { applyFileTreeFilter?: boolean },
		): Promise<FileEntry[]> => {
			track("listDirectory", [path, opts ?? null]);
			if (path in store.directories) return store.directories[path];
			throw new Error(`Directory not found: ${path}`);
		},
		createFile: async (path: string): Promise<void> => {
			track("createFile", [path]);
			if (path in store.files) throw new Error(`Already exists: ${path}`);
			store.files[path] = "";
			const parent = parentDir(path);
			if (parent in store.directories) {
				store.directories[parent].push({ name: baseName(path), path, isDirectory: false });
			}
		},
		createDirectory: async (path: string): Promise<void> => {
			track("createDirectory", [path]);
			if (path in store.directories) throw new Error(`Already exists: ${path}`);
			store.directories[path] = [];
			const parent = parentDir(path);
			if (parent in store.directories) {
				store.directories[parent].push({ name: baseName(path), path, isDirectory: true });
			}
		},
		pathExists: async (path: string): Promise<boolean> => {
			track("pathExists", [path]);
			return path in store.files || path in store.directories;
		},
		fileExists: async (path: string): Promise<boolean> => {
			track("fileExists", [path]);
			return path in store.files;
		},
		renameEntry: async (oldPath: string, newPath: string): Promise<void> => {
			track("renameEntry", [oldPath, newPath]);
			const prefix = `${oldPath}/`;
			const remap = (entries: FileEntry[]): FileEntry[] =>
				entries.map((e) => ({ ...e, path: newPath + e.path.slice(oldPath.length) }));
			for (const k of Object.keys(store.files)) {
				if (k.startsWith(prefix)) {
					store.files[newPath + k.slice(oldPath.length)] = store.files[k];
					delete store.files[k];
				}
			}
			if (oldPath in store.files) {
				store.files[newPath] = store.files[oldPath];
				delete store.files[oldPath];
			}
			for (const k of Object.keys(store.directories)) {
				if (k.startsWith(prefix)) {
					store.directories[newPath + k.slice(oldPath.length)] = remap(store.directories[k]);
					delete store.directories[k];
				}
			}
			if (oldPath in store.directories) {
				store.directories[newPath] = remap(store.directories[oldPath]);
				delete store.directories[oldPath];
			}
			const parent = parentDir(oldPath);
			if (parent in store.directories) {
				const ent = store.directories[parent].find((e) => e.path === oldPath);
				if (ent) {
					ent.name = baseName(newPath);
					ent.path = newPath;
				}
			}
		},
		deleteEntry: async (path: string): Promise<void> => {
			track("deleteEntry", [path]);
			const prefix = `${path}/`;
			for (const k of Object.keys(store.files)) {
				if (k.startsWith(prefix)) delete store.files[k];
			}
			delete store.files[path];
			for (const k of Object.keys(store.directories)) {
				if (k.startsWith(prefix)) delete store.directories[k];
			}
			delete store.directories[path];
			const parent = parentDir(path);
			if (parent in store.directories) {
				store.directories[parent] = store.directories[parent].filter((e) => e.path !== path);
			}
		},

		startWatcher: async (path: string): Promise<void> => {
			track("startWatcher", [path]);
		},
		stopWatcher: async (): Promise<void> => {
			track("stopWatcher", []);
		},
		onFsChange: (cb: (events: FsChangeEvent[]) => void): (() => void) => {
			store.fsListeners.push(cb);
			return () => {
				store.fsListeners = store.fsListeners.filter((x) => x !== cb);
			};
		},
		onWorkspaceReloadTree: (_cb: () => void): (() => void) => {
			// e2e mock では FileTree フィルタ設定変更を発火しない（実 main プロセスを
			// 起動しない renderer-only モードのため）。listener は no-op を返す。
			return () => {};
		},

		searchFiles: async (
			workspacePath: string,
			rawQuery: string,
			caseSensitive?: boolean,
		): Promise<SearchResult[]> => {
			track("searchFiles", [workspacePath, rawQuery, caseSensitive ?? false]);
			const querySearch = caseSensitive ? rawQuery : rawQuery.toLowerCase();
			if (!querySearch) return [];
			// 本番 search.ts:104-106 と同じく path の byte 比較で sort してから走査。
			// 検索結果の順序が決定的になり、テスト assertion を安定させる。
			const mdFiles = collectMdFiles(workspacePath).sort(byteCmp);
			const results: SearchResult[] = [];
			for (const filePath of mdFiles) {
				const content = store.files[filePath];
				if (!content) continue;
				const lines = content.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					const lineSearch = caseSensitive ? line : line.toLowerCase();
					// case-insensitive 時は lowercased 文字列上の position を元行の
					// UTF-16 position に逆引きする（本番 search.ts:127-135 と一致）。
					// `İ` 等の長さが変わる文字を含む行で matchStart/matchEnd がズレる問題を防ぐ。
					const lowerToOrig = caseSensitive ? null : buildLowerToOrigUtf16Map(line);
					let pos = 0;
					while (true) {
						const found = lineSearch.indexOf(querySearch, pos);
						if (found === -1) break;
						const lowerEnd = found + querySearch.length;
						const matchStart = lowerToOrig ? lowerToOrig[found] : found;
						const matchEnd = lowerToOrig ? lowerToOrig[lowerEnd] : lowerEnd;
						results.push({
							filePath,
							lineNumber: i + 1,
							lineContent: line,
							matchStart,
							matchEnd,
						});
						pos = lowerEnd;
					}
				}
			}
			return results;
		},
		cancelSearch: async (): Promise<void> => {
			track("cancelSearch", []);
		},
		searchFilenames: async (workspacePath: string, query: string): Promise<string[]> => {
			track("searchFilenames", [workspacePath, query]);
			// 本番 search.ts:158-160 と同じ: byte sort → 空クエリは全件、それ以外は basename に
			// 対して fuzzyMatch（フルパスではない）。
			const mdFiles = collectMdFiles(workspacePath).sort(byteCmp);
			if (query === "") return mdFiles;
			return mdFiles.filter((p) => fuzzyMatch(query, baseName(p)));
		},
		scanUnresolvedWikilinks: async (workspacePath: string): Promise<UnresolvedWikilink[]> => {
			track("scanUnresolvedWikilinks", [workspacePath]);
			const encoder = new TextEncoder();
			const mdFiles = collectMdFiles(workspacePath);
			const existingPages = new Set<string>();
			for (const filePath of mdFiles) {
				const file = baseName(filePath);
				if (file.toLowerCase().endsWith(".md")) {
					existingPages.add(file.slice(0, -3).normalize("NFC"));
				}
			}
			const unresolvedMap: Record<string, UnresolvedWikilink["references"]> = {};
			for (const filePath of mdFiles) {
				const content = store.files[filePath];
				if (!content) continue;
				// 本番 search.ts:210 と同じく \r\n / \n 両対応。CRLF Markdown で
				// `\r` が lineContent / contextBefore / contextAfter に残る差異を防ぐ。
				const lines = content.split(/\r?\n/);
				let inCodeBlock = false;
				const re = /\[\[([^[\]\n\r]+)\]\]/g;
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					const trimmed = line.trimStart();
					if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
						inCodeBlock = !inCodeBlock;
						continue;
					}
					if (inCodeBlock) continue;
					re.lastIndex = 0;
					let m: RegExpExecArray | null = null;
					while (true) {
						m = re.exec(line);
						if (!m) break;
						const inner = m[1];
						const pipeIdx = inner.indexOf("|");
						const page = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
						if (
							!page ||
							page.includes("/") ||
							page.includes("\\") ||
							page === "." ||
							page === ".." ||
							page.includes("..")
						)
							continue;
						const stripped = page.toLowerCase().endsWith(".md") ? page.slice(0, -3) : page;
						const normalized = stripped.normalize("NFC");
						if (!normalized || existingPages.has(normalized)) continue;
						const refs = unresolvedMap[normalized] ?? [];
						refs.push({
							filePath,
							lineNumber: i + 1,
							byteOffset: encoder.encode(line.slice(0, m.index)).length + 1,
							lineContent: line,
							contextBefore: lines.slice(Math.max(0, i - 3), i),
							contextAfter: lines.slice(i + 1, Math.min(lines.length, i + 4)),
						});
						unresolvedMap[normalized] = refs;
					}
				}
			}
			// 実装側 (electron/main/ipc/search.ts) と同じバイト比較順を使う。
			// localeCompare はロケール依存で順序がズレるためテスト assertion が脆くなる。
			return Object.entries(unresolvedMap)
				.map(([pageName, references]) => ({ pageName, references }))
				.sort((a, b) => (a.pageName < b.pageName ? -1 : a.pageName > b.pageName ? 1 : 0));
		},
		cancelWikilinkScan: async (): Promise<void> => {
			track("cancelWikilinkScan", []);
		},

		fetchOgp: async (url: string): Promise<OgpData> => {
			track("fetchOgp", [url]);
			return { title: null, description: null, image: null, siteName: null, url };
		},
		exportPdf: async (html: string, outputPath: string): Promise<void> => {
			track("exportPdf", [html, outputPath]);
		},
		checkForUpdate: async (currentVersion: string): Promise<UpdateInfo> => {
			track("checkForUpdate", [currentVersion]);
			return {
				hasUpdate: false,
				latestVersion: currentVersion,
				currentVersion,
				releaseUrl: "",
			};
		},

		gitCheckAvailable: async (): Promise<boolean> => {
			track("gitCheckAvailable", []);
			return false;
		},
		gitCheckRepo: async (path: string): Promise<boolean> => {
			track("gitCheckRepo", [path]);
			return false;
		},
		gitStatus: async (path: string): Promise<GitStatus> => {
			track("gitStatus", [path]);
			return { branch: "", changedFilesCount: 0, conflictFiles: [], hasRemote: false };
		},
		gitAddAll: async (path: string): Promise<void> => {
			track("gitAddAll", [path]);
		},
		gitCommit: async (path: string, message: string): Promise<string> => {
			track("gitCommit", [path, message]);
			return "";
		},
		gitPull: async (path: string, syncMethod: SyncMethod): Promise<string> => {
			track("gitPull", [path, syncMethod]);
			return "";
		},
		gitPush: async (path: string): Promise<string> => {
			track("gitPush", [path]);
			return "";
		},
		gitGetConflictedFiles: async (path: string): Promise<string[]> => {
			track("gitGetConflictedFiles", [path]);
			return [];
		},
		gitGetConflictContent: async (path: string, filePath: string): Promise<ConflictContent> => {
			track("gitGetConflictContent", [path, filePath]);
			return { ours: "", theirs: "" };
		},
		gitResolveConflict: async (
			path: string,
			filePath: string,
			content: string,
			resolution: "modify" | "delete",
		): Promise<void> => {
			track("gitResolveConflict", [path, filePath, content, resolution]);
		},
		gitFinishConflictResolution: async (path: string): Promise<string> => {
			track("gitFinishConflictResolution", [path]);
			return "";
		},
		gitGetLastCommitTime: async (path: string): Promise<string | null> => {
			track("gitGetLastCommitTime", [path]);
			return null;
		},
		emitConflictResolved: async (workspacePath: string): Promise<void> => {
			track("emitConflictResolved", [workspacePath]);
			for (const ln of store.conflictListeners) ln(workspacePath);
		},
		onConflictResolved: (cb: (workspacePath: string) => void): (() => void) => {
			store.conflictListeners.push(cb);
			return () => {
				store.conflictListeners = store.conflictListeners.filter((x) => x !== cb);
			};
		},

		onMenuEvent: (name: MenuEventName, cb: () => void): (() => void) => {
			const list = store.menuListeners[name] ?? [];
			list.push(cb);
			store.menuListeners[name] = list;
			return () => {
				store.menuListeners[name] = (store.menuListeners[name] ?? []).filter((x) => x !== cb);
			};
		},

		settingsGet: async (key: string): Promise<unknown> => {
			track("settingsGet", [key]);
			return store.settings[key];
		},
		settingsSet: async (key: string, value: unknown): Promise<void> => {
			track("settingsSet", [key, value]);
			store.settings[key] = value;
		},
		settingsDelete: async (key: string): Promise<void> => {
			track("settingsDelete", [key]);
			delete store.settings[key];
		},
		settingsSave: async (): Promise<void> => {
			track("settingsSave", []);
		},
	};

	(window as unknown as { api: Api }).api = api;
}
