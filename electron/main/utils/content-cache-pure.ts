// L2 ContentCache の純関数 LRU 実装。副作用ゼロで、副作用ある wrapper (search-cache.ts) から
// 使う。#394 Phase B。
//
// key = canonical ioPath、value = readFile 済み string。予算超過分は挿入順の古い方から evict する。
// get は「アクセス順序を最新化」する touch であり、set は「同 key の値差替 (charge 再計算)
// or 新規挿入 (予算超過分 evict)」を行う。
//
// V8 の String は UTF-16 code unit indexed で 1 コードユニット = 2 バイト消費する
// (rope / one-byte 最適化などの内部最適化はあるが、コスト計算は 2 バイトで安全側倒し)。
// admission cutoff は charge (`text.length * 2`) が limit を超えたら insert しない — cutoff
// 超過ファイルは caller 側で「毎回 readFile」経路で処理する。

const BYTES_PER_CODE_UNIT = 2;

// per-workspace の default 予算。Phase B では定数で始めて、将来 UI 設定化予定 (Issue #394 §2.6)。
export const L2_DEFAULT_BUDGET_BYTES = 64 * 1024 * 1024;
export const L2_ADMISSION_LIMIT_BYTES = 1024 * 1024;

function charge(text: string): number {
	return text.length * BYTES_PER_CODE_UNIT;
}

interface Entry {
	text: string;
	bytes: number;
}

export class ByteLruCache {
	private readonly budgetBytes: number;
	private readonly admissionLimitBytes: number;
	// Map の insertion order をアクセス順序として使う。get で「delete + set」して末尾へ回す
	// ことで、evict は先頭 (最古) から取り出せる。
	private readonly entries = new Map<string, Entry>();
	private totalBytesInternal = 0;

	constructor(
		budgetBytes: number = L2_DEFAULT_BUDGET_BYTES,
		admissionLimitBytes: number = L2_ADMISSION_LIMIT_BYTES,
	) {
		this.budgetBytes = budgetBytes;
		this.admissionLimitBytes = admissionLimitBytes;
	}

	get totalBytes(): number {
		return this.totalBytesInternal;
	}

	get size(): number {
		return this.entries.size;
	}

	// 存在すれば touch (末尾に回す) して text を返す。未存在は undefined。
	get(key: string): string | undefined {
		const e = this.entries.get(key);
		if (e === undefined) return undefined;
		this.entries.delete(key);
		this.entries.set(key, e);
		return e.text;
	}

	// admission: charge が admission limit 超過なら false を返して insert しない
	// (cutoff 超過ファイル。caller は毎回 readFile 経路)。
	// admission reject 時も既存 entry は必ず削除する — 「新値は cutoff 超過で受け入れられない」と
	// 「旧値を保持する」は両立させない (cutoff 未満 → 超過に成長した file で旧・小さい本文が
	// stale hit し続けるのを避けるため)。
	// 同 key 上書き時は既存 charge を差し引いてから新 charge を加算する。
	// 挿入後に予算超過なら挿入順の古い方から evict する (自分自身が evict されないよう
	// 上書きは一旦 delete → set の順で行う)。
	// 戻り値: 実際に格納したかどうか。
	set(key: string, text: string): boolean {
		const c = charge(text);
		const prev = this.entries.get(key);
		if (prev !== undefined) {
			this.totalBytesInternal -= prev.bytes;
			this.entries.delete(key);
		}
		if (c > this.admissionLimitBytes) return false;
		this.entries.set(key, { text, bytes: c });
		this.totalBytesInternal += c;
		this.evictToBudget();
		return true;
	}

	delete(key: string): boolean {
		const e = this.entries.get(key);
		if (e === undefined) return false;
		this.totalBytesInternal -= e.bytes;
		this.entries.delete(key);
		return true;
	}

	// prefix と完全一致するエントリ、および prefix + sep 以下のエントリを一括削除する。
	// prefix / prefixWithSep を独立に受けるのは、`/foo` が `/foobar` に誤 match しないよう
	// にするため。呼び出し側は path (exact) と path + sep (subtree marker) を渡す。
	// Map の反復中に delete する場合は、既存/現在のキーの delete は spec で安全 (未訪問キーの
	// 追加のみ挙動が未規定) — ここでは追加はしないので defensive copy 不要。
	deletePrefix(prefix: string, prefixWithSep: string): number {
		let removed = 0;
		for (const [key, e] of this.entries) {
			if (key === prefix || key.startsWith(prefixWithSep)) {
				this.totalBytesInternal -= e.bytes;
				this.entries.delete(key);
				removed++;
			}
		}
		return removed;
	}

	clear(): void {
		this.entries.clear();
		this.totalBytesInternal = 0;
	}

	private evictToBudget(): void {
		if (this.totalBytesInternal <= this.budgetBytes) return;
		const iter = this.entries.keys();
		while (this.totalBytesInternal > this.budgetBytes) {
			const next = iter.next();
			if (next.done === true) break;
			const key = next.value;
			const e = this.entries.get(key);
			if (e === undefined) continue;
			this.totalBytesInternal -= e.bytes;
			this.entries.delete(key);
		}
	}
}
