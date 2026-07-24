// 全文検索用の bigram 転置索引 (InvertedIndex)。副作用ゼロで、副作用ある wrapper
// (search-cache.ts) から使う。#394 Phase C。
//
// posting は「行内 lowercase bigram → fileId の Set」。fileId は path の数値 intern
// (再利用禁止。delete でも pathToId の entry は消さない — 同名 path が再 create された時に
// 同じ fileId を再ヒットさせるため。indexedEpoch との照合で自動的に未 indexed 扱いになる。
// これは L1/L2 の姉妹罠「epoch 履歴を消すと再 create で偽 valid になる」への対応)。
//
// valid 判定は「fileEpoch (現在世代) と indexedEpoch (index 取り込み時点の世代) の一致」で行う
// 二重照合。invalidate/remove/invalidatePrefix はいずれも「意図ベース bump」— fileEpoch を
// bump するだけで posting の掃除はしない (掃除は tombstone 全 clear に委ねる。掃除より先に
// bump する)。
//
// V8 の String は UTF-16 code unit indexed で 1 コードユニット = 2 バイト消費する。L2 と同じ
// admission cutoff (charge = text.length * 2) を採用する。

import { sep } from "node:path";

/** gram 数上限。超過で workspace 単位で index 無効化 (workspace 生存中は復活しない)。 */
export const MAX_GRAM_COUNT = 2_000_000;
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
 * - fallback kind: 全 file 素通し (query.length < 2 / 改行含む / disabled / 未 indexed 多数)。
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
	private readonly admissionMaxBytes: number;
	private readonly tombstoneRatio: number;

	// fileId intern。delete でも entry を消さない (再 create で同じ fileId を再利用するため)。
	private pathToId = new Map<string, number>();
	private idToPath: string[] = [];
	private nextId = 0;

	// 現在世代。invalidate/remove/invalidatePrefix で bump する。
	private fileEpoch = new Map<number, number>();
	// index 取り込み時点の世代。indexFile で fileEpoch と同期する。
	// valid ⟺ indexedEpoch.get(id) === (fileEpoch.get(id) ?? 0)
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
	private disabled = false;

	constructor(opts?: {
		maxGramCount?: number;
		admissionMaxBytes?: number;
		tombstoneRatio?: number;
	}) {
		this.maxGramCount = opts?.maxGramCount ?? MAX_GRAM_COUNT;
		this.admissionMaxBytes = opts?.admissionMaxBytes ?? INDEX_ADMISSION_MAX_BYTES;
		this.tombstoneRatio = opts?.tombstoneRatio ?? TOMBSTONE_RATIO;
	}

	get gramCount(): number {
		return this.grams.size;
	}

	get isDisabled(): boolean {
		return this.disabled;
	}

	get indexedValidCount(): number {
		return this.validCount;
	}

	// piggyback / idle fill が read 前に snapshot する用。
	// **重要**: 未登録 path はここで pathToId に登録する (fileEpoch は未設定のまま=0 相当)。
	// これをしないと、read 中に applyFsBatch → invalidate(path) が「path 未登録」で no-op になり、
	// epoch が bump されないまま readFile 完了時の handle.indexFile が capturedEpoch=0 と
	// current=0 で一致して stale text を index する race (Phase C 版 stale-insert race)。
	// L2 が cache に無い key への modify でも global generation を bump するのと同じ意図で、
	// path 単位でも「read 中の file を invalidate 可能な状態」に持ち込む。
	currentEpochOf(ioPath: string): number {
		const id = this.getOrCreateId(ioPath);
		return this.fileEpoch.get(id) ?? 0;
	}

	isIndexedAndValid(ioPath: string): boolean {
		const id = this.pathToId.get(ioPath);
		if (id === undefined) return false;
		const indexed = this.indexedEpoch.get(id);
		if (indexed === undefined) return false;
		return indexed === (this.fileEpoch.get(id) ?? 0);
	}

	private getOrCreateId(ioPath: string): number {
		const existing = this.pathToId.get(ioPath);
		if (existing !== undefined) return existing;
		const id = this.nextId++;
		this.pathToId.set(ioPath, id);
		this.idToPath[id] = ioPath;
		return id;
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
		const cur = this.fileEpoch.get(id) ?? 0;
		const prev = this.indexedEpoch.get(id);
		const wasValid = prev !== undefined && prev === cur;
		this.indexedEpoch.set(id, cur);
		if (!wasValid) this.validCount++;
	}

	private forgetIndexed(id: number): void {
		const prev = this.indexedEpoch.get(id);
		if (prev === undefined) return;
		const wasValid = prev === (this.fileEpoch.get(id) ?? 0);
		this.indexedEpoch.delete(id);
		if (wasValid) this.validCount--;
	}

	// 意図ベース bump: fileEpoch を進めるだけ。posting は残置する (tombstone clear で回収)。
	private bumpFileEpoch(id: number): void {
		const cur = this.fileEpoch.get(id) ?? 0;
		const prev = this.indexedEpoch.get(id);
		const wasValid = prev !== undefined && prev === cur;
		this.fileEpoch.set(id, cur + 1);
		if (wasValid) this.validCount--;
	}

	indexFile(ioPath: string, text: string): void {
		if (this.disabled) return;

		const c = charge(text);
		const id = this.getOrCreateId(ioPath);

		if (c > this.admissionMaxBytes) {
			// reject: 既存 indexed 情報 (indexedEpoch entry と posting からの当該 fileId 削除) を除去する。
			// 「新値受入拒否 + 旧値保持」は両立させない。
			this.removeFromPostings(id);
			this.forgetIndexed(id);
			this.maybeClearOnTombstoneRatio();
			return;
		}

		// 既存 indexed (更新) の場合、先に posting から古い fileId 参照を除去してから追加する
		// (bigram set が変化しうるため)。
		this.removeFromPostings(id);

		const lower = text.toLowerCase();
		const lines = lower.split(/\r?\n/);
		const uniqueGrams = new Set<string>();
		for (const line of lines) {
			for (const g of bigramsOfLine(line)) {
				uniqueGrams.add(g);
			}
		}
		for (const g of uniqueGrams) {
			let set = this.grams.get(g);
			if (set === undefined) {
				set = new Set<number>();
				this.grams.set(g, set);
			}
			set.add(id);
		}
		// idToGrams 逆引きを更新する (uniqueGrams と同じ Set を共有すると mutation の相互作用が
		// あるため、独立コピーを持たせる)。
		this.idToGrams.set(id, new Set(uniqueGrams));

		if (this.grams.size > this.maxGramCount) {
			// gram 上限退避: workspace 生存中は復活しない。
			this.disabled = true;
			this.grams.clear();
			this.idToGrams.clear();
			this.indexedEpoch.clear();
			this.validCount = 0;
			return;
		}

		// indexedEpoch を fileEpoch と同期 (indexFile 完了時点で valid にする)。
		this.markValid(id);

		this.maybeClearOnTombstoneRatio();
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
		if (this.disabled) return { kind: "fallback" };

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
			if (indexed !== undefined && indexed === (this.fileEpoch.get(id) ?? 0)) {
				const path = this.idToPath[id];
				if (path !== undefined) candidates.add(path);
			}
		}
		return { kind: "candidates", candidates, indexedValid };
	}

	private collectIndexedValid(): Set<string> {
		const out = new Set<string>();
		for (const [id, epoch] of this.indexedEpoch) {
			if (epoch === (this.fileEpoch.get(id) ?? 0)) {
				const path = this.idToPath[id];
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
		this.grams.clear();
		this.idToGrams.clear();
		this.indexedEpoch.clear();
		this.validCount = 0;
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
