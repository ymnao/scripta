import { promises as fsp } from "node:fs";
import { basename, join, resolve } from "node:path";
import pLimit from "p-limit";
import type { SearchResult } from "../../../src/types/search";
import type {
	BacklinkSource,
	UnresolvedWikilink,
	WikilinkReference,
} from "../../../src/types/wikilink";
import { handle } from "../utils/ipc-handle";
import { assertPathAllowed } from "../utils/path-guard";
import { buildLowerToOrigUtf16Map } from "../utils/search-pure";

// scan 系 IPC が共有する readFile 並列上限。複数の scan IPC が同時並行しても
// 全体の同時 fd 数を 16 に抑えるために module-level で 1 つ作って共有する。
const ioLimit = pLimit(16);

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

	const querySearch = caseSensitive ? query : query.toLowerCase();
	const results: SearchResult[] = [];

	// isStale は task 開始時に 1 回 check（旧 sequential の per-iter check と等価方針）。
	await Promise.all(
		io.map((ioPath, idx) =>
			ioLimit(async () => {
				if (isStale()) return;
				const inputPath = input[idx];
				let content: string;
				try {
					content = await fsp.readFile(ioPath, "utf8");
				} catch {
					return; // 読み取り失敗ファイルは skip
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
			}),
		),
	);
	if (isStale()) return [];
	// 並列実行で push 順序が乱れるので最終 sort で output 順序を安定化する。
	results.sort((a, b) => {
		if (a.filePath < b.filePath) return -1;
		if (a.filePath > b.filePath) return 1;
		if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber;
		return a.matchStart - b.matchStart;
	});
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
// openOffset は同じ行内の char index（escape / inline code 判定で利用）。
export function* extractWikilinks(
	line: string,
): Generator<{ inner: string; byteOffset: number; openOffset: number }> {
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
			yield {
				inner,
				byteOffset: Buffer.byteLength(line.slice(0, open), "utf8") + 1,
				openOffset: open,
			};
		}
		i = close + 2;
	}
}

// `pos` の直前に連続する `\` が奇数個あるなら escape されている。
// `src/lib/content.ts:isEscaped` と同形ロジック（main / renderer で同一判定を保証するため）。
function isEscaped(line: string, pos: number): boolean {
	let count = 0;
	let i = pos - 1;
	while (i >= 0 && line[i] === "\\") {
		count++;
		i--;
	}
	return count % 2 === 1;
}

// CommonMark 準拠で inline code span 範囲を列挙する。
// 仕様: N 連続のバックティックを開き delimiter、同じ N 連続を閉じ delimiter とする。
//       open 側だけは前置 escape (`\\\``) を除外する (scripta の用途上、escape された
//       backtick で code span を開始させたくないため。CommonMark 上は `\\\`code\\\``
//       は code span として扱われ得るが、現状の wikilink 判定との整合性を優先する)。
//       閉じ側では escape を判定しない。CommonMark 上、close の `` ` `` は backtick
//       string として認識され、直前の `\\` は中身の literal backslash に過ぎないため。
//       例: `` `foo \\\` [[t]] bar` `` は open=pos 0 / close=pos 5 で code span = `foo \\`
//       となり、後続の `[[t]]` は code span 外。live-preview の lezer InlineCode と
//       一致させるためにこの判定にする。
// 引数 s は 1 行でも本文全体でもよい。CommonMark は code span が改行を跨ぐことを
// 許容するため、live-preview の lezer InlineCode と整合させるには本文全体で走らせる
// 必要がある (例: ``` `start\n[[t]]\nend` ``` 形の複数行 span)。
function collectInlineCodeRanges(s: string): Array<{ from: number; to: number }> {
	const ranges: Array<{ from: number; to: number }> = [];
	let i = 0;
	while (i < s.length) {
		if (s[i] !== "`") {
			i++;
			continue;
		}
		// run の先頭が escape されていれば、その backtick run 全体を skip する。
		// `i++` だけだと同じ run の 2 文字目以降を open delimiter として誤開始してしまう
		// (例: `\\\`\\\` [[t]] \\\`` で 2 文字目から code span を開いてしまう)。
		// Lezer / live-preview の InlineCode 判定もこの run 全体を delimiter としない。
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
		// 同じ長さの backtick 連続を閉じとして探す。close 側は escape を見ない
		// (上のコメント参照)。
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
			// 長さが違うバックティック列はスキップ (同じ run の途中で長さが違う閉じは無効)。
			k = closeEnd;
		}
		if (foundCloseEnd !== -1) {
			ranges.push({ from: openStart, to: foundCloseEnd });
			i = foundCloseEnd;
		} else {
			// 閉じが無ければ open delimiter はリテラル。次の文字から再開して探索を続ける。
			i = openEnd;
		}
	}
	return ranges;
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
	// 各行が本文全体の中で始まる char index。`\r\n` / `\n` どちらの行区切りでも揃える。
	const lineStarts: number[] = new Array(lines.length);
	{
		let pos = 0;
		for (let i = 0; i < lines.length; i++) {
			lineStarts[i] = pos;
			pos += lines[i].length;
			if (pos < text.length && text[pos] === "\r") pos++;
			if (pos < text.length && text[pos] === "\n") pos++;
		}
	}
	// fenced code 範囲を line index で識別する。fence marker 行 (``` / ~~~) 自体も
	// fenced 扱いにすることで、後段の mask が marker 行の backtick (``` 等) を
	// 隠し、外側 inline code delimiter と peer になるのを防ぐ。
	const isFenced = findFencedLines(lines);
	// fenced 範囲を space で mask した text を作る (length 保持)。
	// inline code scanner に「fence 内の backtick が見えない」状態を作り、tilde fence
	// 内の `` ` `` が外側の `` ` `` と peer になることを防ぐ。
	const inlineCodeRanges = collectInlineCodeRanges(
		isFenced.some((b) => b) ? maskRanges(text, lines, lineStarts, isFenced) : text,
	);
	for (let i = 0; i < lines.length; i++) {
		if (isFenced[i]) continue;
		const line = lines[i];
		for (const { inner, byteOffset, openOffset } of extractWikilinks(line)) {
			// `\[[...]]` のようにエスケープされた wikilink は live-preview でも
			// リンク扱いされない (src/components/editor/live-preview/wikilinks.ts:78)
			// ので backlink 集計からも除外する。
			if (isEscaped(line, openOffset)) continue;
			// inline code (`` ` ... ` ``) の中の wikilink も除外する。本文全体に対する
			// inlineCodeRanges (CommonMark 準拠の N 連続 backtick scanner、fenced 範囲を
			// mask 済み) で判定する。
			const textPos = lineStarts[i] + openOffset;
			let inInlineCode = false;
			for (const r of inlineCodeRanges) {
				if (r.from <= textPos && textPos < r.to) {
					inInlineCode = true;
					break;
				}
			}
			if (inInlineCode) continue;
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
				// 表示用 preview。BacklinkPanel / UnresolvedLinksPanel (buildInitialContent)
				// は match offset を持たず、leading/trailing whitespace は読みづらいだけ
				// なので producer 側で 1 度 trim する (#227)。byteOffset は raw line に
				// 対する 1-based UTF-8 位置のままで unique key 用途に留めるため、trim
				// との offset 整合は要求しない (BacklinkPanel.tsx:146 / UnresolvedLinksPanel.tsx:145
				// で `${filePath}-${lineNumber}-${byteOffset}` という key token としてのみ使用)。
				lineContent: line.trim(),
				contextBefore: lines.slice(Math.max(0, i - 3), i),
				contextAfter: lines.slice(i + 1, Math.min(lines.length, i + 4)),
			});
		}
	}
}

// 指定 line index 集合の範囲を space に置換した text を返す。length は元と一致する。
// inline code scanner に「対象範囲の文字を空白として見せる」用途で、char index は
// 元の text と互換 (lineStarts / openOffset の換算がそのまま使える)。
function maskRanges(text: string, lines: string[], lineStarts: number[], mask: boolean[]): string {
	const buf = text.split("");
	for (let i = 0; i < lines.length; i++) {
		if (!mask[i]) continue;
		const start = lineStarts[i];
		const end = start + lines[i].length;
		for (let j = start; j < end; j++) buf[j] = " ";
	}
	return buf.join("");
}

// CommonMark / Lezer 準拠の fenced code block 判定。
// - opener: 行頭 0-3 spaces の後に ``` または ~~~ (3 個以上の連続)。info string は OK
// - closer: opener と同じ文字種、opener 以上の長さ、後ろは空白 (space/tab) のみ
// - 4 spaces 以上 indent の行は fence marker として認識しない (CommonMark の
//   indented code block と区別)
// 旧実装は `trimmed.startsWith("```") || trimmed.startsWith("~~~")` で単純 toggle
// していたため、異なる文字種の closer / 長さ違い closer / 過剰 indent ですべて
// close と誤判定し live-preview と乖離していた。
function findFencedLines(lines: string[]): boolean[] {
	const flags: boolean[] = new Array(lines.length).fill(false);
	let opener: { ch: string; length: number } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let indent = 0;
		while (indent < line.length && line[indent] === " ") indent++;
		// 4 spaces 以上 indent の行は fence marker として認識しない。fenced 中なら
		// その行は fenced 範囲のテキストとして扱う。
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
				// opener: info string (markerLen 以降のテキスト) は許容。
				// ただし backtick fence (```) の info string に backtick は含められない
				// (CommonMark / Lezer)。例えば ``` info `x` は fence opener ではなく
				// paragraph として扱われる。
				const afterMarker = line.slice(indent + markerLen);
				if (ch === "`" && afterMarker.includes("`")) {
					continue;
				}
				opener = { ch, length: markerLen };
				flags[i] = true;
				continue;
			}
			// closer 候補: 同じ文字種・長さ ≥ opener・後ろは空白のみ。
			const afterMarker = line.slice(indent + markerLen);
			if (ch === opener.ch && markerLen >= opener.length && /^[ \t]*$/.test(afterMarker)) {
				opener = null;
				flags[i] = true;
				continue;
			}
			// closer 条件を満たさない marker 行は fenced 内のテキスト扱い。
			flags[i] = true;
			continue;
		}
		if (opener !== null) flags[i] = true;
	}
	return flags;
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
	// iterateWikilinkOccurrences の callback は sync block 内で完結するので、
	// 並列 task 間で map への push は race しない（await の境界でのみ task が切り替わる）。
	await Promise.all(
		ioFiles.map((ioPath, idx) =>
			ioLimit(async () => {
				if (isStale()) return;
				let text: string;
				try {
					text = await fsp.readFile(ioPath, "utf8");
				} catch {
					return;
				}
				iterateWikilinkOccurrences(inFiles[idx], text, (pageName, ref) => {
					if (existing.has(pageName)) return;
					const arr = map.get(pageName);
					if (arr === undefined) map.set(pageName, [ref]);
					else arr.push(ref);
				});
			}),
		),
	);
	if (isStale()) return [];

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

	// path-guard 契約: renderer 由来のファイルパスは main 側で認可してから処理する。
	// workspace は後段の collectMdFilesForWorkspace で検証されるが、targetFilePath は
	// 別途明示的に通す (searchFilesImpl と同じく拡張子フィルタ・pageName 正規化より前)。
	await assertPathAllowed(senderId, targetFilePath);

	const targetBase = basename(targetFilePath);
	// walkMdFiles (line 28) と同じ小文字 `.md` のみを対象にする。大文字拡張子の
	// ファイルは scan 対象に含まれず backlink 結果が常に空になるため、ここで早期 return。
	if (!targetBase.endsWith(".md")) return [];
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

	// 同名 basename がワークスペース内に複数ある場合、live-preview の buildFileMap
	// (src/components/editor/live-preview/wikilinks.ts:45) と同じく
	// lexicographically smallest path を canonical とする。targetInput がその
	// canonical でないなら、`[[target]]` の解決先は別ノートになり、本ファイルへの
	// backlink を表示すると live-preview の動作と食い違う。空配列で早期 return。
	const fileMap = new Map<string, string>();
	for (const filePath of inFiles) {
		const name = basename(filePath).slice(0, -3).normalize("NFC");
		if (!name) continue;
		const existing = fileMap.get(name);
		if (!existing || filePath < existing) {
			fileMap.set(name, filePath);
		}
	}
	if (fileMap.get(targetPage) !== targetInput) return [];

	const map = new Map<string, WikilinkReference[]>();
	// ioLimit で並列化（scanUnresolvedWikilinksImpl と同方針）。
	await Promise.all(
		ioFiles.map((ioPath, idx) =>
			ioLimit(async () => {
				if (isStale()) return;
				// 自分自身からのリンクは backlink としては表示しない。
				if (inFiles[idx] === targetInput) return;

				let text: string;
				try {
					text = await fsp.readFile(ioPath, "utf8");
				} catch {
					return;
				}
				iterateWikilinkOccurrences(inFiles[idx], text, (pageName, ref) => {
					if (pageName !== targetPage) return;
					const sourceFile = ref.filePath;
					const arr = map.get(sourceFile);
					if (arr === undefined) map.set(sourceFile, [ref]);
					else arr.push(ref);
				});
			}),
		),
	);
	if (isStale()) return [];

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
