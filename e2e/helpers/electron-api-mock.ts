import type { Page } from "@playwright/test";
import type { Api, MenuEventName, SaveDialogOptions } from "../../electron/preload/api";
import { getInitializedMarkerPath } from "../../src/lib/scripta-config";
import type { ConflictContent, GitStatus, SyncMethod } from "../../src/types/git-sync";
import type { OgpData } from "../../src/types/ogp";
import type { SearchResult } from "../../src/types/search";
import type { UpdateInfo } from "../../src/types/update";
import type { BacklinkSource, UnresolvedWikilink } from "../../src/types/wikilink";
import type { FileEntry, FsChangeEvent } from "../../src/types/workspace";

// renderer-only Playwright で `window.api` を addInitScript 注入するモック。
// 旧 Tauri 版 `tauri-mock.ts` の Electron 移植版（参考: ~/development/tools/scripta/e2e/helpers/tauri-mock.ts）。

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
	workspaceInitialized: boolean;
	initializedMarkerSuffix: string;
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

	// 本番 electron/main/ipc/search.ts の isEscaped / collectInlineCodeRanges と同形ロジック。
	// `addInitScript` 制約で import 不可なのでこの scope に複製する。
	// collectInlineCodeRanges は引数が 1 行でも本文全体でも動く (CommonMark の複数行 span
	// 対応のため、scan 側では本文全体に対して 1 回計算する)。
	const isEscaped = (s: string, pos: number): boolean => {
		let count = 0;
		let i = pos - 1;
		while (i >= 0 && s[i] === "\\") {
			count++;
			i--;
		}
		return count % 2 === 1;
	};
	const collectInlineCodeRanges = (s: string): Array<{ from: number; to: number }> => {
		// 本番 search.ts:collectInlineCodeRanges と同形。close 側は escape を見ない
		// (CommonMark の backtick string 認識に escape を含めない仕様、live-preview と整合)。
		// open 側は escape された backtick run 全体を skip する (i++ だけだと run の
		// 2 文字目以降を open として誤開始するため)。
		const ranges: Array<{ from: number; to: number }> = [];
		let i = 0;
		while (i < s.length) {
			if (s[i] !== "`") {
				i++;
				continue;
			}
			if (isEscaped(s, i)) {
				let runEnd = i;
				while (runEnd < s.length && s[runEnd] === "`") runEnd++;
				i = runEnd;
				continue;
			}
			const openStart = i;
			let openEnd = i;
			while (openEnd < s.length && s[openEnd] === "`") openEnd++;
			const openLen = openEnd - openStart;
			let k = openEnd;
			let foundCloseEnd = -1;
			while (k < s.length) {
				if (s[k] !== "`") {
					k++;
					continue;
				}
				let closeEnd = k;
				while (closeEnd < s.length && s[closeEnd] === "`") closeEnd++;
				if (closeEnd - k === openLen) {
					foundCloseEnd = closeEnd;
					break;
				}
				k = closeEnd;
			}
			if (foundCloseEnd !== -1) {
				ranges.push({ from: openStart, to: foundCloseEnd });
				i = foundCloseEnd;
			} else {
				i = openEnd;
			}
		}
		return ranges;
	};
	// 本文全体の inline code ranges と各行の text 内 start position を計算する小 helper。
	// 両 scan mock で同じ前処理を使うために集約する。
	const buildLineStarts = (text: string, lines: string[]): number[] => {
		const lineStarts = new Array<number>(lines.length);
		let pos = 0;
		for (let i = 0; i < lines.length; i++) {
			lineStarts[i] = pos;
			pos += lines[i].length;
			if (pos < text.length && text[pos] === "\r") pos++;
			if (pos < text.length && text[pos] === "\n") pos++;
		}
		return lineStarts;
	};
	const isInRanges = (ranges: Array<{ from: number; to: number }>, pos: number): boolean => {
		for (const r of ranges) {
			if (r.from <= pos && pos < r.to) return true;
		}
		return false;
	};
	// CommonMark / Lezer 準拠の fenced code block 判定。本番 search.ts:findFencedLines と同形。
	// - opener: 行頭 0-3 spaces の後に ``` または ~~~ (3 個以上の連続)。info string は OK
	// - closer: opener と同じ文字種、opener 以上の長さ、後ろは空白のみ
	// - 4 spaces 以上 indent の行は fence marker と認識しない
	const findFencedLines = (lines: string[]): boolean[] => {
		const flags = new Array<boolean>(lines.length).fill(false);
		let opener: { ch: string; length: number } | null = null;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			let indent = 0;
			while (indent < line.length && line[indent] === " ") indent++;
			if (indent >= 4) {
				if (opener !== null) flags[i] = true;
				continue;
			}
			const ch = line[indent];
			let markerLen = 0;
			if (ch === "`" || ch === "~") {
				while (indent + markerLen < line.length && line[indent + markerLen] === ch) markerLen++;
			}
			if (markerLen >= 3) {
				if (opener === null) {
					// backtick fence の info string に backtick は許容されない
					// (CommonMark / Lezer)。tilde fence では制約なし。本番 search.ts と同形。
					const afterOpener = line.slice(indent + markerLen);
					if (ch === "`" && afterOpener.includes("`")) {
						continue;
					}
					opener = { ch, length: markerLen };
					flags[i] = true;
					continue;
				}
				const afterMarker = line.slice(indent + markerLen);
				if (ch === opener.ch && markerLen >= opener.length && /^[ \t]*$/.test(afterMarker)) {
					opener = null;
					flags[i] = true;
					continue;
				}
				flags[i] = true;
				continue;
			}
			if (opener !== null) flags[i] = true;
		}
		return flags;
	};
	// 指定 line index の文字を space に置換した text を返す。length は元と一致するため
	// lineStarts / m.index の換算がそのまま使える。
	const maskRanges = (
		text: string,
		lines: string[],
		lineStarts: number[],
		mask: boolean[],
	): string => {
		const buf = text.split("");
		for (let i = 0; i < lines.length; i++) {
			if (!mask[i]) continue;
			const start = lineStarts[i];
			const end = start + lines[i].length;
			for (let j = start; j < end; j++) buf[j] = " ";
		}
		return buf.join("");
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
				const lineStarts = buildLineStarts(content, lines);
				const isFenced = findFencedLines(lines);
				// fenced 範囲を space mask した text で inline code ranges を計算する。
				// fence 内の backtick が外側 inline code delimiter と peer になるのを防ぐ。
				const inlineCodeRanges = collectInlineCodeRanges(
					isFenced.some((b) => b) ? maskRanges(content, lines, lineStarts, isFenced) : content,
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
						// 本番 iterateWikilinkOccurrences と同じく escape / inline code 内は除外。
						if (isEscaped(line, m.index)) continue;
						if (isInRanges(inlineCodeRanges, lineStarts[i] + m.index)) continue;
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
				const name = baseName(filePath).replace(/\.md$/i, "").normalize("NFC");
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
					isFenced.some((b) => b) ? maskRanges(content, lines, lineStarts, isFenced) : content,
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
						if (isInRanges(inlineCodeRanges, lineStarts[i] + m.index)) continue;
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
				.map(([sourceFile, references]) => ({ sourceFile, references }))
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
