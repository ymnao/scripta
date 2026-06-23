import { promises as fsp } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { SearchResult } from "../../../src/types/search";
import type {
	BacklinkSource,
	UnresolvedWikilink,
	WikilinkReference,
} from "../../../src/types/wikilink";
import { handle } from "../utils/ipc-handle";
import { assertPathAllowed } from "../utils/path-guard";
import { buildLowerToOrigUtf16Map } from "../utils/search-pure";

// ワークスペース配下の `.md` ファイルを再帰的に収集する。
// I/O は canonical（path-guard 通過後）、戻り値は input-base に揃えるために
// 2 つの基底パスを並走させる（fs.ts/listDirectoryImpl と同じ方針）。
// `.` で始まるエントリ（ファイル / ディレクトリ）は早期に skip して、隠しディレクトリの
// 中身を readdir しないようにする。
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
	const canonical = await assertPathAllowed(senderId, workspacePath);
	const inputBase = resolve(workspacePath);
	const out: MdFiles = { io: [], input: [] };
	await walkMdFiles(canonical, inputBase, out);
	return out;
}

// 各 query char が target に **順序どおり** 含まれるかを判定する fuzzy match。
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

// 連続入力で古い search / wikilink scan を中断するための per-window 世代カウンタ。
// 同じ window から新しい同種 op が呼ばれると gen を bump し、
// 進行中の古い op は async resumption ごとに gen を確認して早期 return する。
// renderer 側 (SearchPanel.tsx 等) も requestId で stale を捨てているが、
// IPC を投げ捨てるだけでは main の I/O は止まらない。
// search と wikilink scan は世代を独立管理する。共通化すると例えば
// UnresolvedLinksPanel の cleanup で SearchPanel の検索結果まで `[]` にされる
// クロスキャンセル regression が起きるため、cancel IPC も用途別に分ける。
const searchGeneration = new Map<number, number>();
const wikilinkGeneration = new Map<number, number>();
const backlinkGeneration = new Map<number, number>();

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
	backlinkGeneration.delete(windowId);
}

// 明示的な cancel: gen を bump して in-flight searchFilesImpl を bail させる。
// renderer 側でクエリが空になった / panel が unmount された時に呼ばれる。
// 「次の検索が始まる」を待たないと止まらない問題を解消。
export function cancelSearchForWindow(windowId: number): void {
	bumpGeneration(searchGeneration, windowId);
}

// 明示的な cancel: gen を bump して in-flight scanUnresolvedWikilinksImpl を bail させる。
// UnresolvedLinksPanel の cleanup から呼ばれる。
// SearchPanel の searchFilesImpl は巻き込まない（クロスキャンセル防止）。
export function cancelWikilinkScanForWindow(windowId: number): void {
	bumpGeneration(wikilinkGeneration, windowId);
}

// 明示的な cancel: gen を bump して in-flight scanBacklinksImpl を bail させる。
// BacklinkPanel の cleanup / target file 切替時に呼ばれる。
// 全文検索 / 未解決リンクスキャンとは独立して管理（クロスキャンセル防止）。
export function cancelBacklinkScanForWindow(windowId: number): void {
	bumpGeneration(backlinkGeneration, windowId);
}

// 全文検索の実装。
// JS の String は UTF-16 code unit indexed なので、「byte → UTF-16 変換段」
// は不要。case-insensitive 時のみ buildLowerToOrigUtf16Map で
// `lineLower` 上の position を `line` 上の position に逆引きする。
async function searchFilesImpl(
	senderId: number,
	workspacePath: string,
	query: string,
	caseSensitive = false,
): Promise<SearchResult[]> {
	// stale checker は assert 前に確保する。await assertPathAllowed で microtask に
	// yield した隙に cancelSearchForWindow が gen を bump するケースをカバーするため。
	const isStale = makeStaleChecker(searchGeneration, senderId);

	// 認可は空クエリでも先に通す（他 IPC ハンドラと整合）。早期 return が
	// path-guard の前にあると、未認可 renderer が `""` で叩いて空配列を取得し、
	// IPC 認可挙動が崩れる。
	await assertPathAllowed(senderId, workspacePath);
	if (query === "") return [];

	const { io, input } = await collectMdFilesForWorkspace(senderId, workspacePath);
	if (isStale()) return [];
	// input-base で byte 比較 sort（lexicographic byte compare）。io はインデックス連動。
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
			continue; // 読み取り失敗ファイルは skip
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
				pos = lowerEnd; // 次の検索開始位置を match 末尾へ進める
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
	// byte 比較（lexicographic byte compare）。
	// localeCompare は使わない — locale 依存ソートで挙動が変わるため。
	input.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	if (query === "") return input;
	return input.filter((p) => fuzzyMatch(query, basename(p)));
}

// path traversal 文字を含むページ名を弾く。
// `..something` のような正当な名前も弾く（`contains("..")` 相当）。
export function isPathTraversal(name: string): boolean {
	return name.includes("/") || name.includes("\\") || name === "." || name.includes("..");
}

// 1 行から `[[inner]]` を順次抽出する。empty inner（`[[]]`）はスキップ。
// byteOffset は `[[` 開始位置の **1-based UTF-8 byte 位置**（unique key 用）。
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

// 1 ファイルの本文から「正規化済み pageName + WikilinkReference」を順に取り出す共通走査。
// scanUnresolvedWikilinksImpl（未解決リンク）と scanBacklinksImpl（バックリンク）の両方が
// 同じ前処理を必要とし — 改行分割、code-fence の toggle で code block 内は無視、
// `[[inner]]` 抽出、`pipe` 分離、`.md` 拡張子除去、NFC 正規化、path-traversal 弾き —
// 違いは「集めた `pageName` をどう篩い分けるか」と「結果をどう集計するか」だけ。
// onMatch が走査の主体で、`continue` 相当の skip は早期 return で行う。
// ここに集約しておくことで、code-fence 周りの edge case や正規化のバグ修正が
// 一箇所で済み、unresolved とバックリンクのカウントが乖離するのを防げる。
function iterateWikilinkOccurrences(
	sourceFile: string,
	text: string,
	onMatch: (pageName: string, ref: WikilinkReference) => void,
): void {
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
			if (normalized === "") continue;
			onMatch(normalized, {
				filePath: sourceFile,
				lineNumber: i + 1,
				byteOffset,
				lineContent: line,
				contextBefore: lines.slice(Math.max(0, i - 3), i),
				contextAfter: lines.slice(i + 1, Math.min(lines.length, i + 4)),
			});
		}
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
		iterateWikilinkOccurrences(inFiles[idx], text, (pageName, ref) => {
			if (existing.has(pageName)) return;
			const arr = map.get(pageName);
			if (arr === undefined) map.set(pageName, [ref]);
			else arr.push(ref);
		});
	}

	const result: UnresolvedWikilink[] = [];
	for (const [pageName, references] of map) {
		result.push({ pageName, references });
	}
	// pageName の byte 比較で昇順。
	result.sort((a, b) => (a.pageName < b.pageName ? -1 : a.pageName > b.pageName ? 1 : 0));
	return result;
}

// 指定ノートを `[[ファイル名]]` で参照しているノートを収集する（順引きと逆方向）。
// 解決ロジックは scanUnresolvedWikilinksImpl と同じ正規化（拡張子除去 + NFC + path-traversal 弾き）を
// 通すため、ホバーで参照件数を出す機能と件数が一致する。self-reference は canonical path 一致で除外。
async function scanBacklinksImpl(
	senderId: number,
	workspacePath: string,
	targetFilePath: string,
): Promise<BacklinkSource[]> {
	const isStale = makeStaleChecker(backlinkGeneration, senderId);

	const targetBase = basename(targetFilePath);
	if (!targetBase.toLowerCase().endsWith(".md")) return [];
	const targetPage = targetBase.slice(0, -3).normalize("NFC");
	if (targetPage === "") return [];
	// inFiles は collectMdFilesForWorkspace で `resolve(workspacePath)` ベースに揃って
	// 構築されており、renderer が渡す targetFilePath も同じワークスペース基底に基づく
	// (listDirectory が返した input 形式)。symlink を解決した canonical 比較を使うと
	// `/tmp` → `/private/tmp` のような環境差で self-reference を見落とすので、
	// 同じ input ベースで `resolve()` 正規化したものどうしを比較する。
	const targetInput = resolve(targetFilePath);

	const { io: ioFiles, input: inFiles } = await collectMdFilesForWorkspace(senderId, workspacePath);
	if (isStale()) return [];

	const map = new Map<string, WikilinkReference[]>();
	for (let idx = 0; idx < ioFiles.length; idx++) {
		// ファイル間のチェックポイント（scanUnresolvedWikilinksImpl と同方針）。
		if (isStale()) return [];
		// 自分自身からのリンクは backlink としては表示しない。
		if (inFiles[idx] === targetInput) continue;

		let text: string;
		try {
			text = await fsp.readFile(ioFiles[idx], "utf8");
		} catch {
			continue;
		}
		iterateWikilinkOccurrences(inFiles[idx], text, (pageName, ref) => {
			if (pageName !== targetPage) return;
			const sourceFile = ref.filePath;
			const arr = map.get(sourceFile);
			if (arr === undefined) map.set(sourceFile, [ref]);
			else arr.push(ref);
		});
	}

	const result: BacklinkSource[] = [];
	for (const [sourceFile, references] of map) {
		result.push({ sourceFile, references });
	}
	// sourceFile の byte 比較で昇順（scanUnresolvedWikilinksImpl と同方針）。
	result.sort((a, b) => (a.sourceFile < b.sourceFile ? -1 : a.sourceFile > b.sourceFile ? 1 : 0));
	return result;
}

export function registerSearchIpc(): void {
	handle(
		"search:files",
		(
			event,
			workspacePath: string,
			query: string,
			caseSensitive?: boolean,
		): Promise<SearchResult[]> =>
			searchFilesImpl(event.sender.id, workspacePath, query, caseSensitive ?? false),
	);
	handle("search:cancel", (event): void => {
		cancelSearchForWindow(event.sender.id);
	});
	handle(
		"search:filenames",
		(event, workspacePath: string, query: string): Promise<string[]> =>
			searchFilenamesImpl(event.sender.id, workspacePath, query),
	);
	handle(
		"search:unresolved-wikilinks",
		(event, workspacePath: string): Promise<UnresolvedWikilink[]> =>
			scanUnresolvedWikilinksImpl(event.sender.id, workspacePath),
	);
	handle("wikilink:cancel", (event): void => {
		cancelWikilinkScanForWindow(event.sender.id);
	});
	handle(
		"search:backlinks",
		(event, workspacePath: string, targetFilePath: string): Promise<BacklinkSource[]> =>
			scanBacklinksImpl(event.sender.id, workspacePath, targetFilePath),
	);
	handle("backlink:cancel", (event): void => {
		cancelBacklinkScanForWindow(event.sender.id);
	});
}

export const __testing = {
	searchFilesImpl,
	searchFilenamesImpl,
	scanUnresolvedWikilinksImpl,
	scanBacklinksImpl,
};
