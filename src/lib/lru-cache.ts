/**
 * 挿入順 LRU (Least Recently Used) キャッシュ。`Map` の insert 順保持を利用し、
 * `get` ごとに `delete + set` で末尾へ移動、`set` で cap 超過時に先頭から evict する。
 *
 * `set` は 1 回で size を高々 cap+1 にしかしないため eviction は最大 1 件で足りる。
 *
 * ## protectFromEviction option
 *
 * 指定時、evict 対象を選ぶ際にまず `protectFromEviction(value) === false` のエントリを
 * 挿入順に探して最初の 1 件を落とす。全 entry が protect されていた場合は fallback として
 * 最古 1 件 (protect も無視) を落とす。用途例: in-flight promise を保護しつつ完了済みを
 * 優先的に捨てたい cache。
 *
 * option 未指定時は単純 LRU (最古 1 件を evict)。
 */
export class LruCache<K, V> {
	private readonly map = new Map<K, V>();
	private readonly capacity: number;
	private readonly protect?: (value: V) => boolean;

	constructor(capacity: number, options?: { protectFromEviction?: (value: V) => boolean }) {
		this.capacity = capacity;
		this.protect = options?.protectFromEviction;
	}

	get size(): number {
		return this.map.size;
	}

	has(key: K): boolean {
		return this.map.has(key);
	}

	/**
	 * touch なしで参照する。LRU 順序を変えたくない用途 (identity 照合等) 向け。
	 */
	peek(key: K): V | undefined {
		return this.map.get(key);
	}

	/**
	 * 参照して LRU 順序を末尾へ更新する。
	 */
	get(key: K): V | undefined {
		const value = this.map.get(key);
		if (value === undefined) return undefined;
		this.map.delete(key);
		this.map.set(key, value);
		return value;
	}

	/**
	 * 挿入 or 上書き。挿入後 cap を超えていれば 1 件 evict する。
	 * `protectFromEviction` 指定時は 非 protect を優先、無ければ最古を fallback。
	 */
	set(key: K, value: V): void {
		this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size <= this.capacity) return;
		if (this.protect) {
			for (const [k, v] of this.map) {
				if (!this.protect(v)) {
					this.map.delete(k);
					return;
				}
			}
		}
		const oldest = this.map.keys().next().value;
		if (oldest !== undefined) this.map.delete(oldest);
	}

	delete(key: K): boolean {
		return this.map.delete(key);
	}

	clear(): void {
		this.map.clear();
	}

	values(): IterableIterator<V> {
		return this.map.values();
	}
}
