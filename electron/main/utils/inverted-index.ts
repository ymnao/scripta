// 全文検索用の bigram 転置索引 (InvertedIndex)。副作用ゼロで、副作用ある wrapper
// (search-cache.ts) から使う。#394 Phase C。
//
// posting は「行内 lowercase bigram → fileId の Set」。fileId は path の数値 intern
// (再利用禁止。delete でも pathToId の entry は消さない (下記の回収を除く) — 同名 path が再 create された時に
// 同じ fileId を再ヒットさせるため。indexedEpoch との照合で自動的に未 indexed 扱いになる。
// これは L1/L2 の姉妹罠「epoch 履歴を消すと再 create で偽 valid になる」への対応)。
// ただし pathToId が MAX_PATH_COUNT に達したら、indexedEpoch を持たない id だけを
// 回収する (#589 B2)。回収した path は indexed 情報を持たないので再ヒットしても偽 valid に
// ならず、fileEpoch の既定値 (epochFloor) を回収時点の採番値へ進めることで、回収前に capture した
// epoch との偽一致も防ぐ。
//
// valid 判定は「fileEpoch (現在世代) と indexedEpoch (index 取り込み時点の世代) の一致」で行う
// 二重照合。invalidate/remove/invalidatePrefix はいずれも「意図ベース bump」— fileEpoch を
// bump するだけで posting の掃除はしない (掃除は tombstone 全 clear に委ねる。掃除より先に
// bump する)。
//
// V8 の String は UTF-16 code unit indexed で 1 コードユニット = 2 バイト消費する。L2 と同じ
// admission cutoff (charge = text.length * 2) を採用する。
//
// **呼び手側の不変条件 (#413)**: workspace 内 symlink (alias、realpath が key と不一致の path) は
// index に載せない。alias の key に対する invalidate は watcher から来ない (event は解決先の path で
// 来る) ため、載せると stale posting が valid のまま残る。この class 自身は path の実体性を判定
// しないので、取り込み側 (search.ts の piggyback / index-fill.ts) がゲートで担保する。
// **成立範囲**: この担保は symlink に限る。hard link は realpath が解決しない (両名前とも自分自身を
// 返す) ため両方が index に載り、片方の名前で書かれた modify event はもう片方の posting を
// invalidate しない — symlink alias と同型の stale posting が残る (#416 で追跡)。

import { sep } from "node:path";

/**
 * gram 数上限。この上限を超えることになる file は取り込まず reject する (#589 B1)。
 * 超過判定は挿入前に行うので、1 file が上限を大きく越えて spike することはない。
 * reject すると saturated が立ち、tombstone clear まで続く。
 */
export const MAX_GRAM_COUNT = 2_000_000;
/**
 * pathToId の登録数上限。到達すると次の新規登録で未使用 id を回収し、回収できた量が上限の半分に
 * 満たなければ新規登録を拒否して saturated にする (#589 B2)。
 */
export const MAX_PATH_COUNT = 100_000;
/** 登録を拒否した path の currentEpochOf。登録済み path の epoch (0 以上) とは一致しない。 */
const UNREGISTERED_EPOCH = -1;
/** L2 と同じ admission cutoff。charge = text.length * 2 (UTF-16 code unit)。 */
export const INDEX_ADMISSION_MAX_BYTES = 1 * 1024 * 1024;
/** stale + removed が indexed 総数の 50% を超えたら全 clear (lazy 再養成)。 */
export const TOMBSTONE_RATIO = 0.5;

const BYTES_PER_CODE_UNIT = 2;

export type CandidateResult =
	| { kind: "fallback" }
	| { kind: "candidates"; candidates: Set<string>; indexedValid: Set<string> };

/**
 * candidates kind の CandidateResult に対して「index が no-match を保証しない = scan 対象」
 * 述語を返す純関数。allowed 集合 = `candidates ∪ (allIoFiles \ indexedValid)` の 1 元素分。
 * buildScanList (scan 対象の絞り込み) と collectViolations (dark assert の許容集合) が
 * 同一公式に依存するため、公式ズレを起こさないよう 1 箇所に集約する。
 */
function isScanEligible(
	ioPath: string,
	candidates: ReadonlySet<string>,
	indexedValid: ReadonlySet<string>,
): boolean {
	return candidates.has(ioPath) || !indexedValid.has(ioPath);
}

/**
 * #394 Phase D の scan list 構築。allIoFiles と getCandidates 戻り値から
 * 「実際に readFile + scan する対象」に絞る。
 * - fallback kind: 全 file 素通し (query.length < 2 / 改行含む / 未 indexed 多数)。
 * - candidates kind: `candidates ∪ (allIoFiles \ indexedValid)` = 候補 file + 未 indexed/stale file。
 *   前者は index が絞った候補、後者は index が「valid ではない」= no-match を保証できない集合。
 *   両方を scan することで「index 0% でも 100% でも同一結果」不変条件を維持する。
 *
 * ioFiles と inFiles は同じ index で対応 (canonical io ↔ input path)。両方を並行に filter して
 * 返す。allIoFiles の元順序は保存 (下流 sort / truncated の非決定性を増やさない)。
 */
export function buildScanList(
	ioFiles: readonly string[],
	inFiles: readonly string[],
	cand: CandidateResult,
): { ioScan: readonly string[]; inScan: readonly string[] } {
	if (cand.kind === "fallback") return { ioScan: ioFiles, inScan: inFiles };
	const { candidates, indexedValid } = cand;
	const ioScan: string[] = [];
	const inScan: string[] = [];
	for (let i = 0; i < ioFiles.length; i++) {
		const p = ioFiles[i];
		if (isScanEligible(p, candidates, indexedValid)) {
			ioScan.push(p);
			inScan.push(inFiles[i]);
		}
	}
	return { ioScan, inScan };
}

/** 1 行分の lowercase 文字列を code unit 単位の重複可 bigram 配列へ分解する純関数 (test 用に export)。 */
export function bigramsOfLine(lineLower: string): string[] {
	if (lineLower.length < 2) return [];
	const out: string[] = [];
	for (let i = 0; i + 2 <= lineLower.length; i++) {
		out.push(lineLower.slice(i, i + 2));
	}
	return out;
}

function charge(text: string): number {
	return text.length * BYTES_PER_CODE_UNIT;
}

export class InvertedIndex {
	private readonly maxGramCount: number;
	private readonly maxPathCount: number;
	private readonly admissionMaxBytes: number;
	private readonly tombstoneRatio: number;

	// fileId intern。delete でも entry を消さない (再 create で同じ fileId を再利用するため)。
	// 消えるのは compactIds で未使用 id を回収するときだけ。回収で穴が空くので idToPath は Map。
	private pathToId = new Map<string, number>();
	private idToPath = new Map<number, string>();
	private nextId = 0;

	// 現在世代。invalidate/remove/invalidatePrefix で bump する。
	// 値は epochCounter からの採番 (per-file +1 ではない)。回収で fileEpoch を捨てても、
	// 以後の採番値は過去に返した値と衝突しない。未設定の file は epochFloor を既定値とする。
	private fileEpoch = new Map<number, number>();
	private epochCounter = 0;
	// 未設定 file の epoch 既定値。回収のたびに採番値まで進め、回収前に capture された
	// epoch (未登録 path なら旧 floor) と二度と一致させない。
	private epochFloor = 0;
	// index 取り込み時点の世代。indexFile で fileEpoch と同期する。
	// valid ⟺ indexedEpoch.get(id) === epochOf(id)
	private indexedEpoch = new Map<number, number>();

	// gram → fileId の posting map。
	private grams = new Map<string, Set<number>>();
	// fileId → その file が寄与している gram Set の逆引き。
	// removeFromPostings が O(全 gram) を回避するため (indexFile 更新時 / cutoff reject 時に効く)。
	// tombstones の計算にも使う (`idToGrams.size - validCount` = posting を持つが valid でない file 数)。
	private idToGrams = new Map<number, Set<string>>();

	// 差分カウンタ。indexedEpoch === fileEpoch な file 数を常に正確に反映する。
	// mutator (indexFile / bumpFileEpoch 系 / delete 系) で incremental に更新することで、
	// indexedEpoch 全走査 (旧 indexedValidCount_ の O(N)) を排除する。
	// tombstones は `idToGrams.size - validCount` で O(1) 算出できるため field は持たない。
	private validCount = 0;
	// saturated (isSaturated) = gram 上限か path 数上限で取り込みを拒否している状態。
	// 恒久停止 (旧 disabled) にしなかったのは、悪意ある file 1 個で最適化を workspace 生存中ずっと
	// 止められるため。フラグ無しの純 reject にしなかったのは、上限到達後も piggyback が毎検索で
	// 全未 index file に realpath + bigram 構築 + reject を繰り返し (#413 と同形の退行)、呼び手が
	// 抑制できなくなるため。
	// 解除は tombstone clear のみ。production の呼び手 (piggyback / idle fill) は saturated 中に
	// indexFile を呼ばない (dev 専用の dark assert の再 index だけが例外) ので、gram 容量が空くのも
	// (removeFromPostings は indexFile 内でしか走らない)、indexedEpoch が空いて id が回収可能になる
	// のも、実質 tombstone clear のときだけ。saturated の間に変更・削除された file が valid 数の半分を
	// 超えると clear が走って回復する。それまで新規 file も変更された file も index に載らず scan
	// される。path 側では新規 path のたびに compactIds の O(pathToId) 走査を繰り返さない役も兼ねる。
	private saturated = false;

	constructor(opts?: {
		maxGramCount?: number;
		maxPathCount?: number;
		admissionMaxBytes?: number;
		tombstoneRatio?: number;
	}) {
		this.maxGramCount = opts?.maxGramCount ?? MAX_GRAM_COUNT;
		this.maxPathCount = opts?.maxPathCount ?? MAX_PATH_COUNT;
		this.admissionMaxBytes = opts?.admissionMaxBytes ?? INDEX_ADMISSION_MAX_BYTES;
		this.tombstoneRatio = opts?.tombstoneRatio ?? TOMBSTONE_RATIO;
	}

	get gramCount(): number {
		return this.grams.size;
	}

	get isSaturated(): boolean {
		return this.saturated;
	}

	get indexedValidCount(): number {
		return this.validCount;
	}

	// piggyback / idle fill が read 前に snapshot する用。
	// **重要**: 未登録 path はここで pathToId に登録する (fileEpoch は未設定のまま=epochFloor 相当)。
	// これをしないと、read 中に applyFsBatch → invalidate(path) が「path 未登録」で no-op になり、
	// epoch が bump されないまま readFile 完了時の handle.indexFile が capturedEpoch と
	// current で一致して stale text を index する race (Phase C 版 stale-insert race)。
	// L2 が cache に無い key への modify でも global generation を bump するのと同じ意図で、
	// path 単位でも「read 中の file を invalidate 可能な状態」に持ち込む。
	// 登録を拒否した path (saturated 中の新規 path) は UNREGISTERED_EPOCH を返す。登録後の epoch とは一致しないので、
	// 拒否中に capture した epoch で後から stale text を index されることはない。
	currentEpochOf(ioPath: string): number {
		const id = this.getOrCreateId(ioPath);
		return id === undefined ? UNREGISTERED_EPOCH : this.epochOf(id);
	}

	isIndexedAndValid(ioPath: string): boolean {
		const id = this.pathToId.get(ioPath);
		if (id === undefined) return false;
		const indexed = this.indexedEpoch.get(id);
		if (indexed === undefined) return false;
		return indexed === this.epochOf(id);
	}

	private epochOf(id: number): number {
		return this.fileEpoch.get(id) ?? this.epochFloor;
	}

	private getOrCreateId(ioPath: string): number | undefined {
		const existing = this.pathToId.get(ioPath);
		if (existing !== undefined) return existing;
		// lookup のみの invalidate/remove/invalidatePrefix は新規登録しないので、回収を誘発できない。
		if (this.pathToId.size >= this.maxPathCount) {
			if (this.saturated || !this.compactIds()) {
				this.saturated = true;
				return undefined;
			}
		}
		const id = this.nextId++;
		this.pathToId.set(ioPath, id);
		this.idToPath.set(id, ioPath);
		return id;
	}

	// indexedEpoch を持たない id (登録だけされた path、reject された file、削除された file) を回収する。
	// 削除 file の posting は tombstone clear まで残るが、indexedEpoch が無いので候補にも indexedValid
	// にも出ず、nextId は単調なので id の再利用も起きない (同名 path を再 create すると新 id で載り、
	// 旧 id の posting は tombstone として数えられたまま clear まで残る)。valid な posting は残すので、live file が
	// 上限未満の workspace で回収が索引を作り直させることはない。回収量が上限の半分に満たなければ
	// 何もせず false を返す:
	// 少量ずつ回収すると、回収した path の再登録 → epoch 変化 → idle fill の再 read が新規 path の
	// たびに繰り返されるため。
	// epochFloor を進める理由: 回収した path P で currentEpochOf(P)=e0 を capture → read 中に
	// invalidate(P) (未登録なので no-op) → 再登録された P の epoch が e0 のままだと stale text を
	// valid として index してしまう。floor は過去に返した任意の値より大きいので一致しない。
	private compactIds(): boolean {
		let reclaimable = 0;
		for (const id of this.pathToId.values()) {
			if (!this.indexedEpoch.has(id)) reclaimable++;
		}
		if (reclaimable * 2 < this.maxPathCount) return false;
		const oldFloor = this.epochFloor;
		this.epochFloor = ++this.epochCounter;
		for (const [path, id] of this.pathToId) {
			if (!this.indexedEpoch.has(id)) {
				this.pathToId.delete(path);
				this.idToPath.delete(id);
				this.fileEpoch.delete(id);
			} else if (!this.fileEpoch.has(id)) {
				this.fileEpoch.set(id, oldFloor);
			}
		}
		return true;
	}

	private clearPostings(): void {
		this.grams.clear();
		this.idToGrams.clear();
		this.indexedEpoch.clear();
		this.validCount = 0;
		this.saturated = false;
	}

	// posting から fileId への参照を全て除去する (indexFile 更新時・admission reject 時に使う)。
	// idToGrams の逆引きで対象 gram のみを触るため O(this file の gram 数)。
	private removeFromPostings(id: number): void {
		const grams = this.idToGrams.get(id);
		if (grams === undefined) return;
		for (const gram of grams) {
			const set = this.grams.get(gram);
			if (set === undefined) continue;
			set.delete(id);
			if (set.size === 0) this.grams.delete(gram);
		}
		this.idToGrams.delete(id);
	}

	// indexedEpoch の set/delete と validCount 差分更新を対で行うヘルパー群。
	private markValid(id: number): void {
		const cur = this.epochOf(id);
		const prev = this.indexedEpoch.get(id);
		const wasValid = prev !== undefined && prev === cur;
		this.indexedEpoch.set(id, cur);
		if (!wasValid) this.validCount++;
	}

	private forgetIndexed(id: number): void {
		const prev = this.indexedEpoch.get(id);
		if (prev === undefined) return;
		const wasValid = prev === this.epochOf(id);
		this.indexedEpoch.delete(id);
		if (wasValid) this.validCount--;
	}

	// 意図ベース bump: fileEpoch を進めるだけ。posting は残置する (tombstone clear で回収)。
	private bumpFileEpoch(id: number): void {
		const prev = this.indexedEpoch.get(id);
		const wasValid = prev !== undefined && prev === this.epochOf(id);
		this.fileEpoch.set(id, ++this.epochCounter);
		if (wasValid) this.validCount--;
	}

	indexFile(ioPath: string, text: string): void {
		const id = this.getOrCreateId(ioPath);
		if (id === undefined) return;

		// 既存 indexed (更新) の場合、先に posting から古い fileId 参照を除去する。reject 時も
		// 「新値受入拒否 + 旧値保持」は両立させないので、どの経路でも最初に除去してよい。
		// gram 上限の判定はこの除去後の grams.size を baseline にする。
		this.removeFromPostings(id);

		// raw 長で先に弾くのは巨大 file の toLowerCase (O(n) の文字列確保) 自体を避けるため。
		if (charge(text) > this.admissionMaxBytes) {
			this.rejectFile(id);
			return;
		}
		const lower = text.toLowerCase();
		// toLowerCase は伸長しうる (İ → i + U+0307)。bigram は lower から作るので、raw の charge だけでは
		// cutoff をすり抜けて 1 file で想定の 2 倍の gram を仕込める。
		if (charge(lower) > this.admissionMaxBytes) {
			this.rejectFile(id);
			return;
		}

		const uniqueGrams = this.collectNewGramsWithinCeiling(lower);
		if (uniqueGrams === null) {
			// rejectFile より先に立てる: reject が tombstone clear を誘発したら clearPostings が下ろす。
			// 逆順だと空の index に saturated が残り、tombstone を作れないまま恒久停止する。
			this.saturated = true;
			this.rejectFile(id);
			return;
		}
		for (const g of uniqueGrams) {
			let set = this.grams.get(g);
			if (set === undefined) {
				set = new Set<number>();
				this.grams.set(g, set);
			}
			set.add(id);
		}
		this.idToGrams.set(id, uniqueGrams);

		// indexedEpoch を fileEpoch と同期 (indexFile 完了時点で valid にする)。
		this.markValid(id);

		this.maybeClearOnTombstoneRatio();
	}

	// reject: posting は indexFile 冒頭で除去済み。残る indexed 情報 (indexedEpoch entry) を除去する。
	private rejectFile(id: number): void {
		this.forgetIndexed(id);
		this.maybeClearOnTombstoneRatio();
	}

	// lower の unique bigram を集める。this.grams に未登録の gram だけを newCount に数え、挿入すると
	// maxGramCount を超えると分かった時点で null を返して中断する。挿入前に確定するので rollback が
	// 要らず、1 file が上限を越えて spike することもない (#589 B1)。既存 gram との重複は posting への
	// 追加のみで key が増えないので数えない。
	private collectNewGramsWithinCeiling(lower: string): Set<string> | null {
		const uniqueGrams = new Set<string>();
		let newCount = 0;
		for (const line of lower.split(/\r?\n/)) {
			for (const g of bigramsOfLine(line)) {
				if (uniqueGrams.has(g)) continue;
				uniqueGrams.add(g);
				if (this.grams.has(g)) continue;
				newCount++;
				if (this.grams.size + newCount > this.maxGramCount) return null;
			}
		}
		return uniqueGrams;
	}

	// .md modify。pathToId 未登録なら no-op。
	invalidate(ioPath: string): void {
		const id = this.pathToId.get(ioPath);
		if (id === undefined) return;
		this.bumpFileEpoch(id);
		this.maybeClearOnTombstoneRatio();
	}

	// .md delete。pathToId 未登録なら no-op。posting は残置する (tombstone clear で回収)。
	// pathToId は残置する (再 create での fileId 再利用のため)。indexedEpoch は削除する
	// (再 create で新 index が入るまで unindexed 扱い)。
	remove(ioPath: string): void {
		const id = this.pathToId.get(ioPath);
		if (id === undefined) return;
		this.bumpFileEpoch(id);
		this.forgetIndexed(id);
		this.maybeClearOnTombstoneRatio();
	}

	// L2 の deletePrefix と同じ範囲判定 (exact または startsWith(prefixWithSep))。
	invalidatePrefix(prefix: string): number {
		const prefixWithSep = prefix.endsWith(sep) ? prefix : prefix + sep;
		let count = 0;
		for (const [path, id] of this.pathToId) {
			if (path === prefix || path.startsWith(prefixWithSep)) {
				this.bumpFileEpoch(id);
				count++;
			}
		}
		this.maybeClearOnTombstoneRatio();
		return count;
	}

	getCandidates(queryLower: string): CandidateResult {
		if (queryLower.length < 2) return { kind: "fallback" };
		if (queryLower.includes("\n") || queryLower.includes("\r")) return { kind: "fallback" };

		const grams = bigramsOfLine(queryLower);
		// query.length >= 2 なので bigramsOfLine は空を返さない。

		// posting size 昇順で intersect すると初期集合が最小になり、以降の走査対象を最小化できる。
		// 先頭 gram で候補 Set を作った後は in-place delete で絞り込む (null 初期値と毎 gram の Set
		// 再構築を排除)。
		const indexedValid = this.collectIndexedValid();
		const postings: Array<Set<number> | undefined> = grams.map((g) => this.grams.get(g));
		if (postings.some((p) => p === undefined || p.size === 0)) {
			return { kind: "candidates", candidates: new Set(), indexedValid };
		}
		postings.sort((a, b) => (a as Set<number>).size - (b as Set<number>).size);
		const intersection = new Set(postings[0] as Set<number>);
		for (let i = 1; i < postings.length; i++) {
			const posting = postings[i] as Set<number>;
			for (const id of intersection) {
				if (!posting.has(id)) intersection.delete(id);
			}
			if (intersection.size === 0) break;
		}

		const candidates = new Set<string>();
		for (const id of intersection) {
			const indexed = this.indexedEpoch.get(id);
			if (indexed !== undefined && indexed === this.epochOf(id)) {
				const path = this.idToPath.get(id);
				if (path !== undefined) candidates.add(path);
			}
		}
		return { kind: "candidates", candidates, indexedValid };
	}

	private collectIndexedValid(): Set<string> {
		const out = new Set<string>();
		for (const [id, epoch] of this.indexedEpoch) {
			if (epoch === this.epochOf(id)) {
				const path = this.idToPath.get(id);
				if (path !== undefined) out.add(path);
			}
		}
		return out;
	}

	// tombstones (posting を持つが valid でない file 数) = idToGrams.size - validCount。
	// 比率が閾値を超えたら grams / indexedEpoch を全 clear する (lazy 再養成)。
	// validCount と idToGrams.size はいずれも差分維持 / O(1) なので判定は O(1)。
	private maybeClearOnTombstoneRatio(): void {
		const tombstones = this.idToGrams.size - this.validCount;
		if (tombstones <= this.validCount * this.tombstoneRatio) return;
		this.clearPostings();
	}
}

/** dark-launch assert: 全走査ヒット集合 ⊆ (candidates ∪ 未indexed/stale 集合) を検証。
 *  違反時は Error を throw (dev/test でのみ呼ばれる)。
 *
 *  caseSensitive=true の query は skip する。文脈依存 toLowerCase (例: ギリシャ語 Final_Sigma、
 *  text "ΑΣΤ" と query "ΑΣ" では lowered bigram 集合が食い違う) により、raw scan と
 *  lowered index で bigram 分解が原理的に一致しないため superset 不変条件を保証できない。
 *  Phase D で caseSensitive を index 経由化するなら別途 case-preserving index が必要。 */
export function verifyIndexSuperset(
	index: InvertedIndex,
	query: string,
	caseSensitive: boolean,
	allIoFiles: readonly string[],
	hitIoFiles: readonly string[],
): void {
	if (caseSensitive) return;
	const violations = collectViolations(index, query.toLowerCase(), allIoFiles, hitIoFiles);
	if (violations === null || violations.length === 0) return;
	throw new Error(
		`InvertedIndex superset invariant violated: hit file "${violations[0]}" not in candidate set ` +
			`(query="${query}")`,
	);
}

/**
 * dark assert 用の violation 内訳返却 (#394 Phase D / #399 Finding 1)。
 * verifyIndexSuperset は最初の違反で throw するが、こちらは全違反を配列で返し、
 * 呼び手側で「違反 file を disk から再 index → 再度 collectViolations で残 violation を確認」
 * → 空になれば watcher-latency 窓と判定 (warn)、残れば真の superset 破損 (throw) の
 * 切り分けを可能にする。fallback / caseSensitive skip 時は null。
 */
export function collectViolations(
	index: InvertedIndex,
	queryLower: string,
	// allIoFiles は現時点で判定に使わない (hit ⊆ io は truth scan の構造上自明) が、
	// verifyIndexSuperset との対称性 + 将来の hit-outside-io 診断のため signature に残す。
	_allIoFiles: readonly string[],
	hitIoFiles: readonly string[],
): string[] | null {
	const candResult = index.getCandidates(queryLower);
	if (candResult.kind === "fallback") return null;
	const { candidates, indexedValid } = candResult;
	const violations: string[] = [];
	for (const hit of hitIoFiles) {
		if (!isScanEligible(hit, candidates, indexedValid)) violations.push(hit);
	}
	return violations;
}
