import { promises as fsp } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import pLimit from "p-limit";
import {
	MAX_SEARCH_RESULTS,
	type SearchFilesResponse,
	type SearchResult,
} from "../../../src/types/search";
import type {
	BacklinkSource,
	UnresolvedWikilink,
	UnresolvedWikilinkReference,
	WikilinkReference,
} from "../../../src/types/wikilink";
import { handle } from "../utils/ipc-handle";
import { assertPathAllowed } from "../utils/path-guard";
import {
	buildExistingStemsFrom,
	buildFileMapFrom,
	canonicalToInputPaths,
} from "../utils/search-cache-pure";
import {
	buildLineStarts,
	buildLowerToOrigUtf16Map,
	byteCmp,
	collectInlineCodeRanges,
	findFencedLines,
	fuzzyMatch,
	isEscaped,
	isInRanges,
	maskRanges,
} from "../utils/search-pure";
import {
	getCachedExistingStems,
	getCachedFileMap,
	hasFileListCacheEntry,
	populateFileListCache,
} from "./search-cache";

// scan 系 IPC が共有する readFile 並列上限。複数の scan IPC が同時並行しても
// 全体の同時 fd 数を 16 に抑えるために module-level で 1 つ作って共有する。
const ioLimit = pLimit(16);

// 全 .md を ioLimit 下で並列に読み込んで per-file callback を呼ぶ scan 系 helper。
// searchFilesImpl / scanUnresolvedWikilinksImpl / scanBacklinksImpl が共有する
// boilerplate (Promise.all + ioLimit + isStale 2 重 check + try/catch readFile) を集約する。
// - `isStale` は task 開始時と readFile 後の 2 回 check（旧 sequential の per-iter check と等価方針）。
// - `skipFile` は readFile 前に評価され、true を返した file は IO せずに skip する
//   (scanBacklinksImpl の self-reference skip 用)。
// - `process` は readFile 成功 + isStale 通過後に sync で呼ばれる。await 境界を持たないので
//   複数 task 間で共有 state (Map / 配列) への push は race しない。
async function processMdFilesParallel(
	ioFiles: readonly string[],
	inFiles: readonly string[],
	isStale: () => boolean,
	options: {
		// canonical ioPath を受け取り、readFile 前に skip 判定する。
		// scanBacklinksImpl の self-reference skip 用 (canonical 一致で判定)。
		skipFile?: (ioFile: string) => boolean;
		// 「打ち切り」判定。isStale と異なり、bail は「これまで集めた結果は保持したまま
		// 追加の走査だけ止める」セマンティクス（searchFilesImpl の件数上限用）。
		// isStale の cancel セマンティクス（結果は `[]` 相当）とは混同しないこと。
		shouldBail?: () => boolean;
		process: (inFile: string, text: string) => void;
	},
): Promise<void> {
	const shouldStop = (): boolean => isStale() || options.shouldBail?.() === true;
	await Promise.all(
		ioFiles.map((ioPath, idx) =>
			ioLimit(async () => {
				if (shouldStop()) return;
				if (options.skipFile?.(ioPath)) return;
				const inFile = inFiles[idx];
				let text: string;
				try {
					text = await fsp.readFile(ioPath, "utf8");
				} catch {
					return; // 読み取り失敗ファイルは skip
				}
				// readFile の await 中に stale / bail 化していたら per-file 処理は skip して
				// cancel / 打ち切り反応性を上げる（大きな file ほど効く）。
				if (shouldStop()) return;
				options.process(inFile, text);
			}),
		),
	);
}

// ワークスペース配下の `.md` ファイルを再帰的に収集する (canonical path 側のみ)。
// input-base への変換は collectMdFilesForWorkspace の返却境界で prefix substitution する。
// `.` で始まるエントリ（ファイル / ディレクトリ）は早期に skip して、隠しディレクトリの
// 中身を readdir しないようにする。`node_modules` も同様に早期 skip する（依存パッケージ配下は
// 検索対象外かつ大量ファイルで性能ノイズになるため）。
//
// isStale は #7 の walk cancel 穴の暫定手当。各ディレクトリの readdir 完了直後 1 回
// チェックして stale なら early return する (エントリループ内の await は再帰 walk であり、
// 再帰先の入口チェックで同粒度を得るためループ内チェックは省く)。
// populate 経路 (cache 共有資産) からは isStale を渡さない — walk 自体は完走させる。
// io は cache 経路で共有される readonly array の可能性がある (mutation 禁止)。
// input は canonicalToInputPaths で毎回新規に確保するため mutable でよい。
type MdFiles = { io: readonly string[]; input: string[]; canonicalRoot: string };

async function walkMdFiles(ioDir: string, out: string[], isStale?: () => boolean): Promise<void> {
	if (isStale?.() === true) return;
	const entries = await fsp.readdir(ioDir, { withFileTypes: true });
	if (isStale?.() === true) return;
	for (const ent of entries) {
		if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
		const ioPath = join(ioDir, ent.name);
		if (ent.isDirectory()) {
			await walkMdFiles(ioPath, out, isStale);
		} else if (ent.name.endsWith(".md")) {
			out.push(ioPath);
		}
	}
}

// 各 IPC ハンドラ冒頭の「path-guard 通過 → ワークスペース全 .md 収集」を集約。
// cache 経路:
//   - hit (watcher 稼働中 + populated): 保持中の canonical sorted 配列をそのまま使う。
//   - miss (watcher 稼働中 + 未 populate): populateFileListCache 経由で walk 実行 + 結果格納。
//   - entry なし (watcher 非稼働): 直接 walk 実行 (cache しない)。
// isStale は entry なし経路の walk にのみ伝播する (populate は shared resource として完走させる)。
// 認可は cache hit/miss を問わず冒頭で毎回実行する。cache key を認可済み canonical で
// 生成することで検証スキップの構造を作らない。
async function collectMdFilesForWorkspace(
	senderId: number,
	workspacePath: string,
	isStale?: () => boolean,
): Promise<MdFiles> {
	const canonical = await assertPathAllowed(senderId, workspacePath);
	const inputBase = resolve(workspacePath);
	// 2 分岐: watcher 稼働中 (entry あり) は populate 経由、非稼働は直接 walk。
	// populate は cache hit なら walk 呼び出しをスキップして sorted 済みを即返すため、
	// hit 判定を collectMdFilesForWorkspace 側に持たない ("populated かどうか" の知識を 1 箇所に集約)。
	let ioFiles: readonly string[];
	if (hasFileListCacheEntry(canonical)) {
		// walk は複数 caller 間で dedupe されるため、caller 個別の isStale を伝播しない
		// (dedupe 相手が異なる isStale を持つと、早期 return した側の walk 結果が他 caller に
		// 共有される regression になる)。populate 完了時の cache 格納可否は epoch guard で判定。
		ioFiles = await populateFileListCache(canonical, async () => {
			const arr: string[] = [];
			await walkMdFiles(canonical, arr);
			return arr;
		});
	} else {
		// watcher 非稼働: cache しない直接 walk 経路。caller の isStale を反映して #7 の暫定手当。
		const arr: string[] = [];
		await walkMdFiles(canonical, arr, isStale);
		// callers (searchFilenamesImpl 等) が sort 済みを前提にできるよう cache 経路
		// (getSortedFiles) と同じ byteCmp 順序に揃える。
		arr.sort(byteCmp);
		ioFiles = arr;
	}
	const input = canonicalToInputPaths(ioFiles, canonical, inputBase);
	return { io: ioFiles, input, canonicalRoot: canonical };
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
// filename fuzzy scan は CommandPalette / wikilink-completion / live-preview の buildFileMap
// の 3 系統が同一 window で並行に叩く。他 3 map と異なり「後発が先発を自動 supersede する」
// 意味論は取れない（例: live-preview の buildFileMap fetch が CommandPalette 開閉で `[]` に
// 潰されると全 wikilink が unresolved 表示になる）。よって searchFilenamesImpl は
// makeExplicitStaleChecker を使い、gen bump は cancelFilenameSearchForWindow の
// 明示 cancel でのみ発生させる。map を独立に持つのは cancelSearchForWindow 等の
// cross-cancel 巻き込みを防ぐため（wikilink/backlink と同方針）。
const filenameGeneration = new Map<number, number>();

function bumpGeneration(map: Map<number, number>, windowId: number): void {
	const cur = map.get(windowId);
	if (cur !== undefined) {
		map.set(windowId, cur + 1);
	}
}

// gen を sync に bump し、async resumption ごとの stale 判定クロージャを返す。
// 後発の同種 op が起きると先発が isStale で bail する仕組みを 1 行で書けるようにする。
// 「1 window = 1 UI panel が単一で叩く」contract の op 専用（search / wikilink / backlink）。
// 同一 window で複数の独立 caller が並行に叩く op（filename fuzzy scan など）に使うと、
// caller 同士が互いの in-flight を無音で `[]` に潰す regression になる。
function makeStaleChecker(map: Map<number, number>, windowId: number): () => boolean {
	const myGen = (map.get(windowId) ?? 0) + 1;
	map.set(windowId, myGen);
	return () => map.get(windowId) !== myGen;
}

// bump しない stale checker。呼び出しごとの自動 supersede は行わず、
// 「明示的な cancelXxxForWindow の呼び出しがあった場合のみ bail する」semantic を提供する。
// 同一 window で複数の独立 caller が並行に叩く op（filename fuzzy scan: CommandPalette /
// wikilink-completion / live-preview の buildFileMap 3 系統）向け。
// gen 未初期化時は 0 で初期化しておき、後段の bumpGeneration が動くようにする。
function makeExplicitStaleChecker(map: Map<number, number>, windowId: number): () => boolean {
	const cur = map.get(windowId);
	const myGen = cur ?? 0;
	if (cur === undefined) map.set(windowId, myGen);
	return () => map.get(windowId) !== myGen;
}

export function clearSearchForWindow(windowId: number): void {
	searchGeneration.delete(windowId);
	wikilinkGeneration.delete(windowId);
	backlinkGeneration.delete(windowId);
	filenameGeneration.delete(windowId);
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

// 明示的な cancel: gen を bump して in-flight searchFilenamesImpl を bail させる。
// **window 単位の全 filename fetch を巻き込む** (3 系統: CommandPalette / wikilink-completion
// / live-preview buildFileMap) ので、単一 panel の unmount では呼ばず、
// 全 caller が `[]` を安全に受け入れられるタイミング（ワークスペース切替 / window close 相当）
// でのみ呼ぶ。全文検索 / wikilink / backlink とは独立管理（クロスキャンセル防止）。
export function cancelFilenameSearchForWindow(windowId: number): void {
	bumpGeneration(filenameGeneration, windowId);
}

// 全文検索の実装。
// MAX_SEARCH_RESULTS（src/types/search.ts、renderer の notice 文言と共有）を
// 超えるヒットがあると truncated = true で打ち切り、processMdFilesParallel を
// bail させる（#300）。ファイル並列処理は非決定的なので「どの 10,000 件か」は
// 非決定で構わない（sort は従来通り最後に実施し、収まった件数の中での順序のみ安定させる）。
// JS の String は UTF-16 code unit indexed なので、「byte → UTF-16 変換段」
// は不要。case-insensitive 時のみ buildLowerToOrigUtf16Map で
// `lineLower` 上の position を `line` 上の position に逆引きする。
async function searchFilesImpl(
	senderId: number,
	workspacePath: string,
	query: string,
	caseSensitive = false,
): Promise<SearchFilesResponse> {
	// stale checker は assert 前に確保する。await assertPathAllowed で microtask に
	// yield した隙に cancelSearchForWindow が gen を bump するケースをカバーするため。
	const isStale = makeStaleChecker(searchGeneration, senderId);

	// 認可は空クエリでも先に通す（他 IPC ハンドラと整合）。早期 return が
	// path-guard の前にあると、未認可 renderer が `""` で叩いて空配列を取得し、
	// IPC 認可挙動が崩れる。
	await assertPathAllowed(senderId, workspacePath);
	const emptyResponse: SearchFilesResponse = { results: [], truncated: false };
	if (query === "") return emptyResponse;

	const { io, input } = await collectMdFilesForWorkspace(senderId, workspacePath, isStale);
	if (isStale()) return emptyResponse;

	const querySearch = caseSensitive ? query : query.toLowerCase();
	const results: SearchResult[] = [];
	let truncated = false;

	await processMdFilesParallel(io, input, isStale, {
		shouldBail: () => truncated,
		process: (inputPath, content) => {
			// `content.lines()` 互換（\r\n / \n 両対応で改行除去）
			const lines = content.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				if (truncated) break;
				const line = lines[i];
				const lineSearch = caseSensitive ? line : line.toLowerCase();
				// undefined = 未構築、null = ASCII 行で逆引き不要、number[] = 構築済み。
				// buildLowerToOrigUtf16Map は indexOf がヒットするまで呼ぶ必要がないので
				// 最初のヒット後まで遅延する（#300 ②）。
				let lowerToOrig: number[] | null | undefined;
				let pos = 0;
				while (true) {
					const found = lineSearch.indexOf(querySearch, pos);
					if (found === -1) break;
					// 上限チェックは「上限を超える match が実在する」と分かった時点で行う。
					// push 後に length で判定すると、ちょうど MAX 件ヒットのワークスペースまで
					// 打ち切り扱いになってしまう。
					if (results.length >= MAX_SEARCH_RESULTS) {
						truncated = true;
						break;
					}
					if (lowerToOrig === undefined) {
						lowerToOrig = caseSensitive ? null : buildLowerToOrigUtf16Map(line);
					}
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
		},
	});
	if (isStale()) return emptyResponse;
	// 並列実行で push 順序が乱れるので最終 sort で output 順序を安定化する。
	results.sort((a, b) => {
		if (a.filePath !== b.filePath) return byteCmp(a.filePath, b.filePath);
		if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber;
		return a.matchStart - b.matchStart;
	});
	return { results, truncated };
}

async function searchFilenamesImpl(
	senderId: number,
	workspacePath: string,
	query: string,
): Promise<string[]> {
	// stale checker は最初の await 前に確保する。await collectMdFilesForWorkspace で microtask に
	// yield した隙に cancelFilenameSearchForWindow が gen を bump するケースをカバーするため。
	// 他 3 impl と異なり makeExplicitStaleChecker を使う（呼び出しごとの自動 bump をしない）:
	// 同一 window で 3 系統の caller が並行に叩くため、caller 同士の相互 supersede が起きると
	// 他機能の cache に `[]` が正当な結果として書き込まれる（wikilinks.ts の buildFileMap 等）。
	// また cancel は walkMdFiles の I/O を中断せず、下流の sort / fuzzy filter と stale 結果の
	// 破棄のみを行う（walkMdFiles 自体の中断は #7 と併せた walk 側の対応が必要）。
	const isStale = makeExplicitStaleChecker(filenameGeneration, senderId);

	const { input } = await collectMdFilesForWorkspace(senderId, workspacePath, isStale);
	if (isStale()) return [];
	// collectMdFilesForWorkspace は cache 経路・直接 walk 経路の両方で byteCmp 昇順に揃えて返す
	// (canonical prefix は全要素共通なので prefix substitution 後も順序保存)。
	// localeCompare は使わない — locale 依存ソートで挙動が変わるため。
	// input は canonicalToInputPaths で毎回新規に確保された配列なので、
	// caller が破棄前提でそのまま返してよい (共有 cache 参照ではない)。
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
	const lineStarts = buildLineStarts(text, lines);
	// fenced code 範囲を line index で識別する。fence marker 行 (``` / ~~~) 自体も
	// fenced 扱いにすることで、後段の mask が marker 行の backtick (``` 等) を
	// 隠し、外側 inline code delimiter と peer になるのを防ぐ。
	const isFenced = findFencedLines(lines);
	// fenced 範囲を space で mask した text を作る (length 保持)。
	// inline code scanner に「fence 内の backtick が見えない」状態を作り、tilde fence
	// 内の `` ` `` が外側の `` ` `` と peer になることを防ぐ。maskRanges は mask 全 false
	// 時に text を identity 返却する契約なので、fence が無い file でも同じ呼び方で通す。
	const inlineCodeRanges = collectInlineCodeRanges(maskRanges(text, lines, lineStarts, isFenced));
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
			if (isInRanges(textPos, inlineCodeRanges)) continue;
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

async function scanUnresolvedWikilinksImpl(
	senderId: number,
	workspacePath: string,
): Promise<UnresolvedWikilink[]> {
	const isStale = makeStaleChecker(wikilinkGeneration, senderId);

	const {
		io: ioFiles,
		input: inFiles,
		canonicalRoot,
	} = await collectMdFilesForWorkspace(senderId, workspacePath, isStale);
	if (isStale()) return [];

	// existing_pages は basename から `.md`（小文字一致のみ）を剥いで NFC 正規化した Set。
	// canonical と input で basename は同一なので、cache 経路 (canonical 集計) と
	// fallback (input 集計) は結果が一致する。cache hit 時は共有 Set を再利用する。
	const existing = getCachedExistingStems(canonicalRoot) ?? buildExistingStemsFrom(inFiles);

	const map = new Map<string, UnresolvedWikilinkReference[]>();
	// iterateWikilinkOccurrences の callback は sync block 内で完結するので、
	// 並列 task 間で map への push は race しない（await の境界でのみ task が切り替わる）。
	await processMdFilesParallel(ioFiles, inFiles, isStale, {
		process: (inFile, text) => {
			// inFile は走査中 fix なので displayPath を file 単位で 1 度だけ算出する
			// (BacklinkSource 側 PR #252 と同 pattern、UnresolvedLinksPanel の毎-render
			// toRelativePath 呼び出しを scan-time に hoist)。
			const displayPath = toDisplayPath(workspacePath, inFile);
			iterateWikilinkOccurrences(inFile, text, (pageName, ref) => {
				if (existing.has(pageName)) return;
				const refWithDisplay: UnresolvedWikilinkReference = { ...ref, displayPath };
				const arr = map.get(pageName);
				if (arr === undefined) map.set(pageName, [refWithDisplay]);
				else arr.push(refWithDisplay);
			});
		},
	});
	if (isStale()) return [];

	const result: UnresolvedWikilink[] = [];
	for (const [pageName, references] of map) {
		result.push({ pageName, references });
	}
	// pageName の byte 比較で昇順。
	result.sort((a, b) => byteCmp(a.pageName, b.pageName));
	return result;
}

// main 側 entry-filter.ts:toRel と同じ pattern。Node 標準 relative + posix 正規化で
// workspacePath からの表示用相対 path にする（Windows でも表示は posix 形に統一）。
function toDisplayPath(workspacePath: string, absolutePath: string): string {
	const rel = relative(workspacePath, absolutePath);
	return sep === "/" ? rel : rel.split(sep).join("/");
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
	// canonical を保持しておくと fileMap / self-reference 判定を canonical で一気通貫にできる。
	const targetCanonical = await assertPathAllowed(senderId, targetFilePath);

	const targetBase = basename(targetFilePath);
	// walkMdFiles (line 28) と同じ小文字 `.md` のみを対象にする。大文字拡張子の
	// ファイルは scan 対象に含まれず backlink 結果が常に空になるため、ここで早期 return。
	if (!targetBase.endsWith(".md")) return [];
	const targetPage = targetBase.slice(0, -3).normalize("NFC");
	if (targetPage === "") return [];

	const {
		io: ioFiles,
		input: inFiles,
		canonicalRoot,
	} = await collectMdFilesForWorkspace(senderId, workspacePath, isStale);
	if (isStale()) return [];

	// 同名 basename がワークスペース内に複数ある場合、live-preview の buildFileMap
	// (src/components/editor/live-preview/wikilinks.ts:45) と同じく
	// lexicographically smallest path を canonical とする。target がその canonical で
	// ないなら、`[[target]]` の解決先は別ノートになり、本ファイルへの backlink を
	// 表示すると live-preview の動作と食い違う。空配列で早期 return。
	// fileMap 値は canonical path。cache hit 時は共有 Map を再利用し、miss 時は
	// canonical ioFiles から buildFileMapFrom で構築する (同一関数で結果同一性を担保)。
	// target と fileMap 値の両方を canonical にすることで、symlink workspace でも
	// prefix 差 (`/tmp` vs `/private/tmp`) が原因の見落としが起きない。
	const fileMap = getCachedFileMap(canonicalRoot) ?? buildFileMapFrom(ioFiles);
	if (fileMap.get(targetPage) !== targetCanonical) return [];

	const map = new Map<string, WikilinkReference[]>();
	await processMdFilesParallel(ioFiles, inFiles, isStale, {
		// 自分自身からのリンクは backlink としては表示しない。readFile 前に skip して
		// 不要な fd 消費を避ける。canonical 一致で判定する (fileMap と揃える)。
		skipFile: (ioFile) => ioFile === targetCanonical,
		process: (inFile, text) => {
			iterateWikilinkOccurrences(inFile, text, (pageName, ref) => {
				if (pageName !== targetPage) return;
				const sourceFile = ref.filePath;
				const arr = map.get(sourceFile);
				if (arr === undefined) map.set(sourceFile, [ref]);
				else arr.push(ref);
			});
		},
	});
	if (isStale()) return [];

	const result: BacklinkSource[] = [];
	for (const [sourceFile, references] of map) {
		result.push({
			sourceFile,
			displayName: basename(sourceFile),
			displayPath: toDisplayPath(workspacePath, sourceFile),
			references,
		});
	}
	// sourceFile の byte 比較で昇順（scanUnresolvedWikilinksImpl と同方針）。
	result.sort((a, b) => byteCmp(a.sourceFile, b.sourceFile));
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
		): Promise<SearchFilesResponse> =>
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
	handle("filename:cancel", (event): void => {
		cancelFilenameSearchForWindow(event.sender.id);
	});
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
