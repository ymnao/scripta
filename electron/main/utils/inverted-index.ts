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

	private tombstones = 0;
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
		return this.indexedValidCount_();
	}

	private indexedValidCount_(): number {
		let n = 0;
		for (const [id, epoch] of this.indexedEpoch) {
			if (epoch === (this.fileEpoch.get(id) ?? 0)) n++;
		}
		return n;
	}

	// idle fill が read 前に snapshot する用。未登録なら 0 相当を返す。
	currentEpochOf(ioPath: string): number {
		const id = this.pathToId.get(ioPath);
		if (id === undefined) return 0;
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
	private removeFromPostings(id: number): void {
		for (const [gram, set] of this.grams) {
			if (set.delete(id)) {
				if (set.size === 0) this.grams.delete(gram);
			}
		}
	}

	indexFile(ioPath: string, text: string): void {
		if (this.disabled) return;

		const c = charge(text);
		const id = this.getOrCreateId(ioPath);

		if (c > this.admissionMaxBytes) {
			// reject: 既存 indexed 情報 (indexedEpoch entry と posting からの当該 fileId 削除) を除去する。
			// 「新値受入拒否 + 旧値保持」は両立させない。
			if (this.indexedEpoch.has(id)) {
				this.removeFromPostings(id);
				this.indexedEpoch.delete(id);
				this.tombstones++;
			}
			this.maybeClearOnTombstoneRatio();
			return;
		}

		// 既存 indexed (更新) の場合、先に posting から古い fileId 参照を除去してから追加する
		// (bigram set が変化しうるため)。
		if (this.indexedEpoch.has(id)) {
			this.removeFromPostings(id);
		}

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

		if (this.grams.size > this.maxGramCount) {
			// gram 上限退避: workspace 生存中は復活しない。
			this.disabled = true;
			this.grams.clear();
			this.indexedEpoch.clear();
			this.tombstones = 0;
			return;
		}

		// indexedEpoch を fileEpoch と同期 (indexFile 完了時点で valid にする)。
		this.indexedEpoch.set(id, this.fileEpoch.get(id) ?? 0);

		this.maybeClearOnTombstoneRatio();
	}

	// .md modify。pathToId 未登録なら no-op。
	invalidate(ioPath: string): void {
		const id = this.pathToId.get(ioPath);
		if (id === undefined) return;
		this.bumpEpoch(id);
		this.maybeClearOnTombstoneRatio();
	}

	// .md delete。pathToId 未登録なら no-op。posting・pathToId は残置する
	// (posting は tombstone clear で回収、pathToId は再 create での fileId 再利用のため)。
	remove(ioPath: string): void {
		const id = this.pathToId.get(ioPath);
		if (id === undefined) return;
		this.fileEpoch.set(id, (this.fileEpoch.get(id) ?? 0) + 1);
		// indexedEpoch は削除する (再 create で新 index が入るまで unindexed 扱い)。
		if (this.indexedEpoch.has(id)) {
			this.indexedEpoch.delete(id);
			this.tombstones++;
		}
		this.maybeClearOnTombstoneRatio();
	}

	// L2 の deletePrefix と同じ範囲判定 (exact または startsWith(prefixWithSep))。
	invalidatePrefix(prefix: string): number {
		const prefixWithSep = prefix.endsWith(sep) ? prefix : prefix + sep;
		let count = 0;
		for (const [path, id] of this.pathToId) {
			if (path === prefix || path.startsWith(prefixWithSep)) {
				this.bumpEpoch(id);
				count++;
			}
		}
		this.maybeClearOnTombstoneRatio();
		return count;
	}

	// 意図ベース bump: fileEpoch を進めるだけ。既存 indexedEpoch と不一致になった
	// (かつ indexedEpoch に entry がある) 場合のみ tombstones を増やす。posting は残置する。
	private bumpEpoch(id: number): void {
		const prevIndexed = this.indexedEpoch.get(id);
		const wasValid = prevIndexed !== undefined && prevIndexed === (this.fileEpoch.get(id) ?? 0);
		this.fileEpoch.set(id, (this.fileEpoch.get(id) ?? 0) + 1);
		if (wasValid) {
			this.tombstones++;
		}
	}

	getCandidates(queryLower: string): CandidateResult {
		if (queryLower.length === 0) return { kind: "fallback" };
		if (queryLower.length === 1) return { kind: "fallback" };
		if (queryLower.includes("\n") || queryLower.includes("\r")) return { kind: "fallback" };
		if (this.disabled) return { kind: "fallback" };

		const grams = bigramsOfLine(queryLower);
		// query.length >= 2 なので bigramsOfLine は空を返さない。

		let intersection: Set<number> | null = null;
		for (const g of grams) {
			const posting = this.grams.get(g);
			if (posting === undefined || posting.size === 0) {
				intersection = new Set<number>();
				break;
			}
			if (intersection === null) {
				intersection = new Set(posting);
				continue;
			}
			const next = new Set<number>();
			for (const id of intersection) {
				if (posting.has(id)) next.add(id);
			}
			intersection = next;
		}

		const candidates = new Set<string>();
		if (intersection !== null) {
			for (const id of intersection) {
				const indexed = this.indexedEpoch.get(id);
				if (indexed !== undefined && indexed === (this.fileEpoch.get(id) ?? 0)) {
					const path = this.idToPath[id];
					if (path !== undefined) candidates.add(path);
				}
			}
		}

		const indexedValid = new Set<string>();
		for (const [id, epoch] of this.indexedEpoch) {
			if (epoch === (this.fileEpoch.get(id) ?? 0)) {
				const path = this.idToPath[id];
				if (path !== undefined) indexedValid.add(path);
			}
		}

		return { kind: "candidates", candidates, indexedValid };
	}

	// tombstones > indexedValidCount * ratio かつ indexedEpoch のうち valid でない entry が
	// 実際に多い時、grams / indexedEpoch を全 clear する (lazy 再養成)。
	private maybeClearOnTombstoneRatio(): void {
		const validCount = this.indexedValidCount_();
		if (this.tombstones <= validCount * this.tombstoneRatio) return;

		let staleCount = 0;
		for (const [id, epoch] of this.indexedEpoch) {
			if (epoch !== (this.fileEpoch.get(id) ?? 0)) staleCount++;
		}
		if (staleCount <= validCount * this.tombstoneRatio) return;

		this.grams.clear();
		this.indexedEpoch.clear();
		this.tombstones = 0;
	}
}

/** dark-launch assert: 全走査ヒット集合 ⊆ (candidates ∪ 未indexed/stale 集合) を検証。
 *  違反時は Error を throw (dev/test でのみ呼ばれる)。 */
export function verifyIndexSuperset(
	index: InvertedIndex,
	query: string,
	caseSensitive: boolean,
	allIoFiles: readonly string[],
	hitIoFiles: readonly string[],
): void {
	const queryLower = caseSensitive ? query : query.toLowerCase();
	// 実際には caseSensitive でも lowercase index で候補を取る (superset なので)。
	const candResult = index.getCandidates(caseSensitive ? query.toLowerCase() : queryLower);
	if (candResult.kind === "fallback") return; // fallback 時は全走査扱いなので assert 不要
	const allowed = new Set<string>(candResult.candidates);
	// 未 indexed または stale な file (allIoFiles \ indexedValid) はどう転んでも allowed。
	for (const p of allIoFiles) {
		if (!candResult.indexedValid.has(p)) allowed.add(p);
	}
	for (const hit of hitIoFiles) {
		if (!allowed.has(hit)) {
			throw new Error(
				`InvertedIndex superset invariant violated: hit file "${hit}" not in candidate set ` +
					`(query="${query}", caseSensitive=${caseSensitive})`,
			);
		}
	}
}
