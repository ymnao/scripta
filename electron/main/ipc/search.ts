import { promises as fsp } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ipcMain } from "electron";
import type { SearchResult } from "../../../src/types/search";
import type { UnresolvedWikilink, WikilinkReference } from "../../../src/types/wikilink";
import { assertPathAllowed } from "../utils/path-guard";
import { buildLowerToOrigUtf16Map } from "../utils/search-pure";

// ワークスペース配下の `.md` ファイルを再帰的に収集する。
// I/O は canonical（path-guard 通過後）、戻り値は input-base に揃えるために
// 2 つの基底パスを並走させる（fs.ts/listDirectoryImpl と同じ方針）。
// `.` で始まるエントリ（ファイル / ディレクトリ）は早期に skip して、隠しディレクトリの
// 中身を readdir しないようにする（旧 Rust collect_md_files の挙動 1:1）。
type MdFiles = { io: string[]; input: string[] };

async function walkMdFiles(ioDir: string, inputDir: string, out: MdFiles): Promise<void> {
	const entries = await fsp.readdir(ioDir, { withFileTypes: true });
	for (const ent of entries) {
		if (ent.name.startsWith(".")) continue;
		const ioPath = join(ioDir, ent.name);
		const inPath = join(inputDir, ent.name);
		if (ent.isDirectory()) {
			await walkMdFiles(ioPath, inPath, out);
		} else if (ent.name.endsWith(".md")) {
			out.io.push(ioPath);
			out.input.push(inPath);
		}
	}
}

// 各 IPC ハンドラ冒頭の「path-guard 通過 → ワークスペース全 .md 収集」を集約。
async function collectMdFilesForWorkspace(
	senderId: number,
	workspacePath: string,
): Promise<MdFiles> {
	const canonical = assertPathAllowed(senderId, workspacePath);
	const inputBase = resolve(workspacePath);
	const out: MdFiles = { io: [], input: [] };
	await walkMdFiles(canonical, inputBase, out);
	return out;
}

// 各 query char が target に **順序どおり** 含まれるかを判定する fuzzy match。
// 旧 Rust fuzzy_match (search.rs L159-175) と 1:1 互換。
export function fuzzyMatch(query: string, target: string): boolean {
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
}

// 連続入力で古い search を中断するための per-window 世代カウンタ。
// 同じ window から新しい searchFilesImpl が呼ばれると gen を bump し、
// 進行中の古い検索は async resumption ごとに gen を確認して早期 return する。
// renderer 側 (SearchPanel.tsx) も requestId で stale を捨てているが、
// IPC を投げ捨てるだけでは main の I/O は止まらない。
// scanUnresolvedWikilinksImpl 用の世代は別管理（同種スキャンの先発のみ
// 後発で打ち消す）。明示的 cancel (`search:cancel`) は両方 bump する。
const searchGeneration = new Map<number, number>();
const wikilinkGeneration = new Map<number, number>();

function bumpGeneration(map: Map<number, number>, windowId: number): void {
	const cur = map.get(windowId);
	if (cur !== undefined) {
		map.set(windowId, cur + 1);
	}
}

// gen を sync に bump し、async resumption ごとの stale 判定クロージャを返す。
// 後発の同種 op が起きると先発が isStale で bail する仕組みを 1 行で書けるようにする。
function makeStaleChecker(map: Map<number, number>, windowId: number): () => boolean {
	const myGen = (map.get(windowId) ?? 0) + 1;
	map.set(windowId, myGen);
	return () => map.get(windowId) !== myGen;
}

export function clearSearchForWindow(windowId: number): void {
	searchGeneration.delete(windowId);
	wikilinkGeneration.delete(windowId);
}

// 明示的な cancel: gen を bump して in-flight な search / wikilink scan を bail させる。
// renderer 側でクエリが空になった / panel が unmount された / workspace を切り替えた時に呼ばれる。
// 「次の検索が始まる」を待たないと止まらない問題を解消。
// workspace スキャンは search も wikilink もまとめて止めたいので両方 bump する。
export function cancelSearchForWindow(windowId: number): void {
	bumpGeneration(searchGeneration, windowId);
	bumpGeneration(wikilinkGeneration, windowId);
}

// 旧 Rust src-tauri/src/commands/search.rs の search_files を 1:1 ポート。
// JS の String は UTF-16 code unit indexed なので、旧 Rust の「byte → UTF-16 変換段」
// は不要。case-insensitive 時のみ buildLowerToOrigUtf16Map で
// `lineLower` 上の position を `line` 上の position に逆引きする。
async function searchFilesImpl(
	senderId: number,
	workspacePath: string,
	query: string,
	caseSensitive = false,
): Promise<SearchResult[]> {
	// 認可は空クエリでも先に通す（他 IPC ハンドラと整合）。早期 return が
	// path-guard の前にあると、未認可 renderer が `""` で叩いて空配列を取得し、
	// IPC 認可挙動が崩れる。
	assertPathAllowed(senderId, workspacePath);
	if (query === "") return [];

	const isStale = makeStaleChecker(searchGeneration, senderId);

	const { io, input } = await collectMdFilesForWorkspace(senderId, workspacePath);
	if (isStale()) return [];
	// input-base で byte 比較 sort（旧 Rust md_files.sort() 互換）。io はインデックス連動。
	const order = io
		.map((_, i) => i)
		.sort((a, b) => (input[a] < input[b] ? -1 : input[a] > input[b] ? 1 : 0));

	const querySearch = caseSensitive ? query : query.toLowerCase();
	const results: SearchResult[] = [];

	for (const idx of order) {
		// ファイル間のチェックポイント。1 ファイルの per-line ループは fast なので
		// その内側ではチェックしない（コストの方が大きい）。
		if (isStale()) return [];
		const ioPath = io[idx];
		const inputPath = input[idx];
		let content: string;
		try {
			content = await fsp.readFile(ioPath, "utf8");
		} catch {
			continue; // 旧 Rust: read_to_string Err → continue
		}
		// `content.lines()` 互換（\r\n / \n 両対応で改行除去）
		const lines = content.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineSearch = caseSensitive ? line : line.toLowerCase();
			const lowerToOrig = caseSensitive ? null : buildLowerToOrigUtf16Map(line);
			let pos = 0;
			while (true) {
				const found = lineSearch.indexOf(querySearch, pos);
				if (found === -1) break;
				const lowerEnd = found + querySearch.length;
				const matchStart = lowerToOrig ? lowerToOrig[found] : found;
				const matchEnd = lowerToOrig ? lowerToOrig[lowerEnd] : lowerEnd;
				results.push({
					filePath: inputPath,
					lineNumber: i + 1,
					lineContent: line,
					matchStart,
					matchEnd,
				});
				pos = lowerEnd; // 旧 Rust: search_start = lower_byte_end と同等
			}
		}
	}
	return results;
}

async function searchFilenamesImpl(
	senderId: number,
	workspacePath: string,
	query: string,
): Promise<string[]> {
	const { input } = await collectMdFilesForWorkspace(senderId, workspacePath);
	// byte 比較（旧 Rust の Vec<String>::sort = lexicographic byte compare 互換）。
	// localeCompare は使わない — locale 依存ソートで挙動が変わるため。
	input.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	if (query === "") return input;
	return input.filter((p) => fuzzyMatch(query, basename(p)));
}

// path traversal 文字を含むページ名を弾く（旧 Rust is_path_traversal L222-227 互換）。
// `..something` のような正当な名前も弾く点まで一致させる（旧 Rust の `contains("..")`）。
export function isPathTraversal(name: string): boolean {
	return name.includes("/") || name.includes("\\") || name === "." || name.includes("..");
}

// 1 行から `[[inner]]` を順次抽出する。empty inner（`[[]]`）はスキップ。
// byteOffset は `[[` 開始位置の **1-based UTF-8 byte 位置**（旧 Rust 互換、unique key 用）。
export function* extractWikilinks(line: string): Generator<{ inner: string; byteOffset: number }> {
	let i = 0;
	while (true) {
		const open = line.indexOf("[[", i);
		if (open < 0) return;
		const innerStart = open + 2;
		if (innerStart >= line.length) return;
		const close = line.indexOf("]]", innerStart);
		if (close < 0) return;
		const inner = line.slice(innerStart, close);
		if (inner.length > 0) {
			yield { inner, byteOffset: Buffer.byteLength(line.slice(0, open), "utf8") + 1 };
		}
		i = close + 2;
	}
}

async function scanUnresolvedWikilinksImpl(
	senderId: number,
	workspacePath: string,
): Promise<UnresolvedWikilink[]> {
	const isStale = makeStaleChecker(wikilinkGeneration, senderId);

	const { io: ioFiles, input: inFiles } = await collectMdFilesForWorkspace(senderId, workspacePath);
	if (isStale()) return [];

	// existing_pages は basename から `.md`（小文字一致のみ）を剥いで NFC 正規化した Set。
	const existing = new Set<string>();
	for (const p of inFiles) {
		const name = basename(p);
		if (!name.toLowerCase().endsWith(".md")) continue;
		existing.add(name.slice(0, -3).normalize("NFC"));
	}

	const map = new Map<string, WikilinkReference[]>();
	for (let idx = 0; idx < ioFiles.length; idx++) {
		// ファイル間のチェックポイント。1 ファイルの per-line ループは sync なので
		// その内側ではチェックしない（cost vs. 反応速度のバランス、searchFilesImpl と同方針）。
		if (isStale()) return [];
		let text: string;
		try {
			text = await fsp.readFile(ioFiles[idx], "utf8");
		} catch {
			continue;
		}
		const lines = text.split(/\r?\n/);
		let inCodeBlock = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.replace(/^\s+/, "");
			if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
				inCodeBlock = !inCodeBlock;
				continue;
			}
			if (inCodeBlock) continue;
			for (const { inner, byteOffset } of extractWikilinks(line)) {
				const pipe = inner.indexOf("|");
				const page = pipe >= 0 ? inner.slice(0, pipe) : inner;
				if (page === "" || isPathTraversal(page)) continue;
				const stripped = page.toLowerCase().endsWith(".md") ? page.slice(0, -3) : page;
				const normalized = stripped.normalize("NFC");
				if (normalized === "" || existing.has(normalized)) continue;
				const ref: WikilinkReference = {
					filePath: inFiles[idx],
					lineNumber: i + 1,
					byteOffset,
					lineContent: line,
					contextBefore: lines.slice(Math.max(0, i - 3), i),
					contextAfter: lines.slice(i + 1, Math.min(lines.length, i + 4)),
				};
				const arr = map.get(normalized);
				if (arr === undefined) map.set(normalized, [ref]);
				else arr.push(ref);
			}
		}
	}

	const result: UnresolvedWikilink[] = [];
	for (const [pageName, references] of map) {
		result.push({ pageName, references });
	}
	// pageName の byte 比較で昇順（旧 Rust String::cmp と整合）。
	result.sort((a, b) => (a.pageName < b.pageName ? -1 : a.pageName > b.pageName ? 1 : 0));
	return result;
}

export function registerSearchIpc(): void {
	ipcMain.handle(
		"search:files",
		(
			event,
			workspacePath: string,
			query: string,
			caseSensitive?: boolean,
		): Promise<SearchResult[]> =>
			searchFilesImpl(event.sender.id, workspacePath, query, caseSensitive ?? false),
	);
	ipcMain.handle("search:cancel", (event): void => {
		cancelSearchForWindow(event.sender.id);
	});
	ipcMain.handle(
		"search:filenames",
		(event, workspacePath: string, query: string): Promise<string[]> =>
			searchFilenamesImpl(event.sender.id, workspacePath, query),
	);
	ipcMain.handle(
		"search:unresolved-wikilinks",
		(event, workspacePath: string): Promise<UnresolvedWikilink[]> =>
			scanUnresolvedWikilinksImpl(event.sender.id, workspacePath),
	);
}

export const __testing = {
	searchFilesImpl,
	searchFilenamesImpl,
	scanUnresolvedWikilinksImpl,
};
