import type { Page } from "@playwright/test";
// browser scope に inject する pure helper 群。installApiMock 内側で bare 参照する
// identifier をここに列挙し、下の PURE_HELPERS が同じ列を projection として持つ。
// 追加時は destructure と PURE_HELPERS の 2 箇所を同時更新する。scope は
// installApiMock が実際に使う helper に絞られ、search-pure.ts に将来追加される mock
// 無関係な helper が addInitScript payload に混入することは無い。
//
// **必ず `import * as` + local const destructure の形を保つこと**:
// Playwright 内蔵 babel は helper file を package.json に `"type": "module"` が無い
// 環境 (本 repo の状態) で CommonJS transform し、named import の bare 参照を
// `(0, _searchPure.foo)` や `_searchPure.bar` に rewrite する
// (@babel/plugin-transform-modules-commonjs)。installApiMock.toString() で body を
// browser に運ぶ経路では、この rewrite された参照は `_searchPure` が undefined な
// browser scope で ReferenceError となり全 search / backlink / commandpalette
// handler が壊れる (2026-07-05 CI 失敗の原因)。destructure で一度 local const に
// すると babel は identifier を preserve するため、.toString() の中でも bare の
// identifier 形が残り、SCRIPT_PREFIX で並べた hoisted 関数宣言が browser 側で
// resolve できる。
import * as searchPure from "../../electron/main/utils/search-pure";

const {
	buildLineStarts,
	buildLowerToOrigUtf16Map,
	byteCmp,
	collectInlineCodeRanges,
	findFencedLines,
	fuzzyMatch,
	isAsciiOnly,
	isEscaped,
	isInRanges,
	maskRanges,
} = searchPure;

import type { Api, MenuEventName, SaveDialogOptions } from "../../electron/preload/api";
import { getInitializedMarkerPath } from "../../src/lib/scripta-config";
import type { ConflictContent, GitStatus, SyncMethod } from "../../src/types/git-sync";
import type { OgpData } from "../../src/types/ogp";
import type { SearchFilesResponse, SearchResult } from "../../src/types/search";
import type { UpdateInfo } from "../../src/types/update";
import type { BacklinkSource, UnresolvedWikilink } from "../../src/types/wikilink";
import type { FileEntry, FsChangeEvent } from "../../src/types/workspace";

// renderer-only Playwright で `window.api` を addInitScript 注入するモック。
// 旧 Tauri 版 `tauri-mock.ts` の Electron 移植版（参考: ~/development/tools/scripta/e2e/helpers/tauri-mock.ts）。
//
// installApiMock 内で使う純関数群は search-pure.ts (本番 electron/main/ipc/search.ts が
// import する同じモジュール) の関数をそのまま browser scope に inject する経路を通す。
// addInitScript の callback は 1 個の関数を .toString() して browser 側で実行するため、
// callback スコープの外にある import された関数は参照できない。そこで setup() で以下の
// 順に script content を組み立てる:
//   1. PURE_INJECTION: PURE_HELPERS の各関数を .toString() で並べて先頭に配置
//      → browser scope の hoisted function declaration になる (bare identifier で参照可能)
//   2. (installApiMock.toString())(payload): IIFE として installApiMock を実行
// これにより mock 側 pure helper と本番 search.ts の間で drift が物理的に不可能になる
// (かつては addInitScript 制約で mock 内に 1:1 コピー inline していた)。

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
	/**
	 * workspace を初期化済み (`.scripta/initialized.json` が存在) として扱うか（既定: true）。
	 * 既定で true にすることで、大半の spec が前提とする「既存 workspace」を再現し、
	 * SetupWizard ダイアログが起動時に開いてクリックを遮るのを防ぐ。SetupWizard
	 * 自体を検証する場合のみ false にする。
	 */
	workspaceInitialized?: boolean;
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
	workspaceInitialized: boolean;
}

declare global {
	interface Window {
		__E2E_API_MOCK__?: MockStore;
	}
}

// addInitScript の script content 先頭に .toString() を並べて注入する pure helper 群。
// 上の searchPure destructure と 1:1 対応 (真実源は destructure、この配列はそれを
// value として projection する)。順序は依存関係を意識しない — 関数宣言は hoist される
// ので実質どの順でも動く。
const PURE_HELPERS = [
	buildLineStarts,
	buildLowerToOrigUtf16Map,
	byteCmp,
	collectInlineCodeRanges,
	findFencedLines,
	fuzzyMatch,
	isAsciiOnly,
	isEscaped,
	isInRanges,
	maskRanges,
];

// setup() で毎回 recompute せず、payload 非依存の部分は module load 時に 1 度だけ
// `.toString()` シリアライズする。~750 行のソース serialize を e2e spec ごとに繰り返さない。
// `installApiMock` は function declaration なので hoist され module top で参照可能。
const SCRIPT_PREFIX = `${PURE_HELPERS.map((fn) => fn.toString()).join("\n")}\n(${installApiMock.toString()})(`;
const SCRIPT_SUFFIX = ");";

export class ElectronApiMock {
	private page: Page;

	constructor(page: Page) {
		this.page = page;
	}

	async setup(opts: ElectronApiMockOptions = {}): Promise<void> {
		const payload: Required<ElectronApiMockOptions> & { initializedMarkerSuffix: string } = {
			fs: opts.fs ?? { files: {}, directories: {} },
			dialogResult: opts.dialogResult ?? null,
			saveDialogResult: opts.saveDialogResult ?? null,
			settings: opts.settings ?? {},
			appVersion: opts.appVersion ?? "0.0.0-e2e",
			workspaceInitialized: opts.workspaceInitialized ?? true,
			// 初期化マーカーの相対 suffix（例: ".scripta/initialized.json"）を
			// アプリ本体と同じ真実源 (scripta-config) から導出して drift を防ぐ。
			// 派生値なので公開 option (ElectronApiMockOptions) には含めない。
			initializedMarkerSuffix: getInitializedMarkerPath(""),
		};
		// SCRIPT_PREFIX/SUFFIX は module scope で一度だけ組み立てた静的部分。
		// 各関数は `function name(...) { ... }` 形の宣言に transpile されるので、hoisting
		// で installApiMock の中からも bare identifier で見える (esbuild は関数名を preserve する)。
		await this.page.addInitScript({
			content: `${SCRIPT_PREFIX}${JSON.stringify(payload)}${SCRIPT_SUFFIX}`,
		});
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
	workspaceInitialized: boolean;
	initializedMarkerSuffix: string;
}): void {
	// 本番 src/types/search.ts の MAX_SEARCH_RESULTS と同じ上限値。
	// installApiMock は .toString() で browser scope に注入されるため、module scope の
	// import は参照できず、関数内 local const として複製する必要がある。
	const MAX_SEARCH_RESULTS = 10_000;
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
		workspaceInitialized: opts.workspaceInitialized,
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
			// 本番 (electron/main/ipc/search.ts walkMdFiles) と同じく `.` 始まりと
			// `node_modules` は早期 skip。隠しディレクトリ・依存パッケージの中身は再帰しない。
			if (e.name.startsWith(".") || e.name === "node_modules") continue;
			if (e.isDirectory) out.push(...collectMdFiles(e.path));
			else if (e.name.endsWith(".md")) out.push(e.path);
		}
		return out;
	};

	const parentDir = (path: string): string => {
		const i = path.lastIndexOf("/");
		return i < 0 ? "" : path.slice(0, i);
	};
	const baseName = (path: string): string => {
		const i = path.lastIndexOf("/");
		return i < 0 ? path : path.slice(i + 1);
	};

	// 本番 electron/main/ipc/search.ts:toDisplayPath の mock 版。
	// e2e mock の filePath は正規化済み posix 形なので `/` 区切り前提で計算する
	// (本番は node:path.relative + sep ベースだが、mock は browser scope で走るため node:path は不使用)。
	// scanUnresolvedWikilinks / scanBacklinks の両 handler から共有する。
	const mockDisplayPath = (workspacePath: string, absolutePath: string): string => {
		const wsPrefix = workspacePath.endsWith("/") ? workspacePath : `${workspacePath}/`;
		return absolutePath.startsWith(wsPrefix) ? absolutePath.slice(wsPrefix.length) : absolutePath;
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
			throw Object.assign(new Error(`File not found: ${path}`), { kind: "ENOENT" });
		},
		readFileBase64: async (path: string): Promise<string> => {
			track("readFileBase64", [path]);
			throw Object.assign(new Error(`File not found: ${path}`), { kind: "ENOENT" });
		},
		writeFile: async (path: string, content: string): Promise<void> => {
			track("writeFile", [path, content]);
			store.files[path] = content;
		},
		writeNewFile: async (path: string, content: string): Promise<void> => {
			track("writeNewFile", [path, content]);
			if (path in store.files)
				throw Object.assign(new Error(`Already exists: ${path}`), { kind: "EEXIST" });
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
			throw Object.assign(new Error(`Directory not found: ${path}`), { kind: "ENOENT" });
		},
		createFile: async (path: string): Promise<void> => {
			track("createFile", [path]);
			if (path in store.files)
				throw Object.assign(new Error(`Already exists: ${path}`), { kind: "ALREADY_EXISTS" });
			store.files[path] = "";
			const parent = parentDir(path);
			if (parent in store.directories) {
				store.directories[parent].push({ name: baseName(path), path, isDirectory: false });
			}
		},
		createDirectory: async (path: string): Promise<void> => {
			track("createDirectory", [path]);
			if (path in store.directories)
				throw Object.assign(new Error(`Already exists: ${path}`), { kind: "ALREADY_EXISTS" });
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
			// 初期化マーカー (`.scripta/initialized.json`)。store に明示シードが無くても
			// workspaceInitialized フラグで存在を制御し、SetupWizard の誤表示を防ぐ。
			// suffix は scripta-config から導出された値（drift 防止）。Windows 形式の
			// `\` 区切りパスでも一致するよう、両者を `/` に正規化してから判定する。
			const toPosix = (s: string): string => s.replace(/\\/g, "/");
			if (toPosix(path).endsWith(`/${toPosix(opts.initializedMarkerSuffix)}`)) {
				return store.workspaceInitialized || path in store.files;
			}
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
		): Promise<SearchFilesResponse> => {
			track("searchFiles", [workspacePath, rawQuery, caseSensitive ?? false]);
			const querySearch = caseSensitive ? rawQuery : rawQuery.toLowerCase();
			if (!querySearch) return { results: [], truncated: false };
			// 本番 search.ts:250-252 (searchFilenamesImpl の input.sort(byteCmp)) と同じく
			// path の byte 比較で sort してから走査。mock は並列処理をしないため、file 単位で
			// sort 済み順に処理すれば本番の最終 sort (search.ts:236-240) と同じ順序が得られる。
			const mdFiles = collectMdFiles(workspacePath).sort(byteCmp);
			const results: SearchResult[] = [];
			let truncated = false;
			outer: for (const filePath of mdFiles) {
				const content = store.files[filePath];
				if (!content) continue;
				const lines = content.split(/\r?\n/);
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i];
					const lineSearch = caseSensitive ? line : line.toLowerCase();
					// undefined = 未構築、null = ASCII 行で逆引き不要、number[] = 構築済み。
					// 本番 search.ts:204-213 と同じく、最初の indexOf ヒット後まで
					// buildLowerToOrigUtf16Map の呼び出しを遅延する（#300 ②）。
					// `İ` 等の長さが変わる文字を含む行で matchStart/matchEnd がズレる問題を防ぐ。
					let lowerToOrig: number[] | null | undefined;
					let pos = 0;
					while (true) {
						const found = lineSearch.indexOf(querySearch, pos);
						if (found === -1) break;
						// 本番 search.ts (MAX_SEARCH_RESULTS) と同じ上限 parity。「上限を超える
						// match が実在する」と分かった時点で打ち切る（push 後の length 判定だと
						// ちょうど上限件数ヒットのケースまで打ち切り扱いになる）。renderer-only
						// e2e で truncated notice を検証するために本番と同セマンティクスにする。
						if (results.length >= MAX_SEARCH_RESULTS) {
							truncated = true;
							break outer;
						}
						if (lowerToOrig === undefined) {
							lowerToOrig = caseSensitive ? null : buildLowerToOrigUtf16Map(line);
						}
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
			return { results, truncated };
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
				const lineStarts = buildLineStarts(content, lines);
				const isFenced = findFencedLines(lines);
				// fenced 範囲を space mask した text で inline code ranges を計算する。
				// fence 内の backtick が外側 inline code delimiter と peer になるのを防ぐ。
				const inlineCodeRanges = collectInlineCodeRanges(
					maskRanges(content, lines, lineStarts, isFenced),
				);
				// 本番 scanUnresolvedWikilinksImpl (search.ts) と同じく filePath 単位で
				// displayPath を 1 度だけ算出して push 時に使い回す (file 単位 hoist)。
				const displayPath = mockDisplayPath(workspacePath, filePath);
				const re = /\[\[([^[\]\n\r]+)\]\]/g;
				for (let i = 0; i < lines.length; i++) {
					if (isFenced[i]) continue;
					const line = lines[i];
					re.lastIndex = 0;
					let m: RegExpExecArray | null = null;
					while (true) {
						m = re.exec(line);
						if (!m) break;
						// 本番 iterateWikilinkOccurrences と同じく escape / inline code 内は除外。
						if (isEscaped(line, m.index)) continue;
						if (isInRanges(lineStarts[i] + m.index, inlineCodeRanges)) continue;
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
							displayPath,
							lineNumber: i + 1,
							byteOffset: encoder.encode(line.slice(0, m.index)).length + 1,
							// 本番 iterateWikilinkOccurrences (search.ts:371) と同じく
							// 表示用 preview として trim 済を返す (#227)。
							lineContent: line.trim(),
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
		scanBacklinks: async (
			workspacePath: string,
			targetFilePath: string,
		): Promise<BacklinkSource[]> => {
			track("scanBacklinks", [workspacePath, targetFilePath]);
			const encoder = new TextEncoder();
			const targetBase = baseName(targetFilePath);
			// 本番 scanBacklinksImpl と同じく小文字 `.md` のみ対象。
			// `Target.MD` を target にした場合に本番は [] を返すが mock がバックリンクを
			// 返してしまうと、将来 `.MD` ケースの e2e を足したときに false positive になる。
			if (!targetBase.endsWith(".md")) return [];
			const targetPage = targetBase.slice(0, -3).normalize("NFC");
			if (!targetPage) return [];
			const mdFiles = collectMdFiles(workspacePath);
			// basename 衝突対応: live-preview の buildFileMap (src/components/editor/
			// live-preview/wikilinks.ts:45) と本番 scanBacklinksImpl と同じく、basename →
			// lexicographically smallest path を canonical とする。target がその canonical でない
			// なら、live-preview 上では `[[target]]` は別ノートに解決されるため空配列を返す。
			const fileMap: Record<string, string> = {};
			for (const filePath of mdFiles) {
				const name = baseName(filePath).slice(0, -3).normalize("NFC");
				if (!name) continue;
				const existing = fileMap[name];
				if (!existing || filePath < existing) {
					fileMap[name] = filePath;
				}
			}
			if (fileMap[targetPage] !== targetFilePath) return [];
			// isEscaped / collectInlineCodeRanges / isInRanges / findFencedLines / maskRanges は
			// installApiMock 冒頭の共通 helper。
			const map: Record<string, BacklinkSource["references"]> = {};
			for (const filePath of mdFiles) {
				// 本番 search.ts:scanBacklinksImpl と同じく self-reference は除外。
				// e2e mock の filePath は正規化済み posix 形なので canonical 化は不要。
				if (filePath === targetFilePath) continue;
				const content = store.files[filePath];
				if (!content) continue;
				const lines = content.split(/\r?\n/);
				const lineStarts = buildLineStarts(content, lines);
				const isFenced = findFencedLines(lines);
				const inlineCodeRanges = collectInlineCodeRanges(
					maskRanges(content, lines, lineStarts, isFenced),
				);
				const re = /\[\[([^[\]\n\r]+)\]\]/g;
				for (let i = 0; i < lines.length; i++) {
					if (isFenced[i]) continue;
					const line = lines[i];
					re.lastIndex = 0;
					let m: RegExpExecArray | null = null;
					while (true) {
						m = re.exec(line);
						if (!m) break;
						if (isEscaped(line, m.index)) continue;
						if (isInRanges(lineStarts[i] + m.index, inlineCodeRanges)) continue;
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
						if (!normalized || normalized !== targetPage) continue;
						const refs = map[filePath] ?? [];
						refs.push({
							filePath,
							lineNumber: i + 1,
							byteOffset: encoder.encode(line.slice(0, m.index)).length + 1,
							// 本番 iterateWikilinkOccurrences (search.ts:371) と同じく
							// 表示用 preview として trim 済を返す (#227)。
							lineContent: line.trim(),
							contextBefore: lines.slice(Math.max(0, i - 3), i),
							contextAfter: lines.slice(i + 1, Math.min(lines.length, i + 4)),
						});
						map[filePath] = refs;
					}
				}
			}
			return Object.entries(map)
				.map(([sourceFile, references]) => ({
					sourceFile,
					displayName: baseName(sourceFile),
					displayPath: mockDisplayPath(workspacePath, sourceFile),
					references,
				}))
				.sort((a, b) => (a.sourceFile < b.sourceFile ? -1 : a.sourceFile > b.sourceFile ? 1 : 0));
		},
		cancelBacklinkScan: async (): Promise<void> => {
			track("cancelBacklinkScan", []);
		},

		fetchOgp: async (requestId: string, url: string): Promise<OgpData> => {
			track("fetchOgp", [requestId, url]);
			return { title: null, description: null, image: null, siteName: null, url };
		},
		ogpCancel: async (requestId: string): Promise<void> => {
			track("ogpCancel", [requestId]);
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
