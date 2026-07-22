import { describe, expect, it } from "vitest";
import { ByteLruCache, L2_ADMISSION_LIMIT_BYTES } from "./content-cache-pure";

// 1 code unit = 2 bytes 前提の helper (charge = length * 2)
const bytes = (n: number): string => "a".repeat(n / 2);

describe("ByteLruCache", () => {
	describe("basic set/get", () => {
		it("stores and retrieves", () => {
			const c = new ByteLruCache(1024, 512);
			expect(c.set("k", "hello")).toBe(true);
			expect(c.get("k")).toBe("hello");
			expect(c.size).toBe(1);
			expect(c.totalBytes).toBe(10); // "hello" = 5 code units * 2
		});

		it("returns undefined on miss", () => {
			const c = new ByteLruCache(1024, 512);
			expect(c.get("missing")).toBeUndefined();
		});

		it("delete removes entry and adjusts totalBytes", () => {
			const c = new ByteLruCache(1024, 512);
			c.set("k", "hello");
			expect(c.delete("k")).toBe(true);
			expect(c.get("k")).toBeUndefined();
			expect(c.totalBytes).toBe(0);
		});

		it("delete on missing key returns false", () => {
			const c = new ByteLruCache(1024, 512);
			expect(c.delete("nope")).toBe(false);
		});
	});

	describe("touch on get", () => {
		it("get moves entry to most-recently-used position", () => {
			const c = new ByteLruCache(30, 30); // budget = 30 bytes = 15 code units
			c.set("a", bytes(10)); // 5 units, 10 bytes
			c.set("b", bytes(10));
			c.set("c", bytes(10)); // total 30
			// touch a → LRU order becomes b, c, a
			expect(c.get("a")).toBe(bytes(10));
			// insert d (10 bytes) → total 40 > 30, evict b (oldest after touch)
			c.set("d", bytes(10));
			expect(c.get("b")).toBeUndefined();
			expect(c.get("c")).toBeDefined();
			expect(c.get("a")).toBeDefined();
			expect(c.get("d")).toBeDefined();
		});
	});

	describe("budget eviction", () => {
		it("evicts oldest entries when budget exceeded", () => {
			const c = new ByteLruCache(20, 20); // 10 code units
			c.set("a", bytes(10)); // 5 units
			c.set("b", bytes(10));
			c.set("c", bytes(10)); // total 30 > 20, evict a
			expect(c.get("a")).toBeUndefined();
			expect(c.get("b")).toBeDefined();
			expect(c.get("c")).toBeDefined();
			expect(c.totalBytes).toBe(20);
		});

		it("same-key overwrite recalculates charge", () => {
			const c = new ByteLruCache(100, 100);
			c.set("k", bytes(10));
			c.set("k", bytes(20));
			expect(c.totalBytes).toBe(20);
			expect(c.get("k")).toBe(bytes(20));
			expect(c.size).toBe(1);
		});

		it("same-key overwrite is not evicted by itself when it fits", () => {
			const c = new ByteLruCache(20, 20);
			c.set("a", bytes(10));
			c.set("b", bytes(10));
			// overwrite a with same-size value; totalBytes stays 20
			c.set("a", bytes(10));
			expect(c.get("a")).toBeDefined();
			expect(c.get("b")).toBeDefined();
		});
	});

	describe("admission cutoff", () => {
		it("rejects entries above admission limit", () => {
			const c = new ByteLruCache(1024 * 1024 * 100, L2_ADMISSION_LIMIT_BYTES);
			// admission limit = 1 MiB = 524288 code units. 600000 units = 1_200_000 bytes > 1 MiB
			expect(c.set("big", "a".repeat(600_000))).toBe(false);
			expect(c.get("big")).toBeUndefined();
			expect(c.size).toBe(0);
		});

		it("accepts entries exactly at admission limit", () => {
			const c = new ByteLruCache(1024 * 1024 * 100, L2_ADMISSION_LIMIT_BYTES);
			// exactly 1 MiB = 524288 code units
			const s = "a".repeat(L2_ADMISSION_LIMIT_BYTES / 2);
			expect(c.set("edge", s)).toBe(true);
		});

		it("removes existing entry when new value is rejected by admission cutoff", () => {
			// regression: cutoff 未満 → 超過に成長した file で旧・小さい本文が stale hit し続けないこと
			const c = new ByteLruCache(1024 * 1024 * 100, L2_ADMISSION_LIMIT_BYTES);
			expect(c.set("k", "small")).toBe(true);
			expect(c.get("k")).toBe("small");
			// oversized value is rejected — but the old entry must be evicted, not preserved
			expect(c.set("k", "a".repeat(600_000))).toBe(false);
			expect(c.get("k")).toBeUndefined();
			expect(c.totalBytes).toBe(0);
		});
	});

	describe("deletePrefix", () => {
		it("removes exact prefix match", () => {
			const c = new ByteLruCache(1024, 512);
			c.set("/ws/foo", "x");
			c.set("/ws/foo/a.md", "y");
			c.set("/ws/foo/b.md", "z");
			c.set("/ws/other.md", "w");
			const removed = c.deletePrefix("/ws/foo", "/ws/foo/");
			expect(removed).toBe(3);
			expect(c.get("/ws/foo")).toBeUndefined();
			expect(c.get("/ws/foo/a.md")).toBeUndefined();
			expect(c.get("/ws/other.md")).toBe("w");
		});

		it("does not match /foo against /foobar", () => {
			const c = new ByteLruCache(1024, 512);
			c.set("/foo", "x");
			c.set("/foobar", "y");
			c.set("/foobar/a.md", "z");
			const removed = c.deletePrefix("/foo", "/foo/");
			expect(removed).toBe(1);
			expect(c.get("/foo")).toBeUndefined();
			expect(c.get("/foobar")).toBe("y");
			expect(c.get("/foobar/a.md")).toBe("z");
		});

		it("adjusts totalBytes when entries are removed", () => {
			const c = new ByteLruCache(1024, 512);
			c.set("/a/x", "hello"); // 10 bytes
			c.set("/a/y", "hi"); // 4 bytes
			c.set("/b/z", "!"); // 2 bytes
			c.deletePrefix("/a", "/a/");
			expect(c.totalBytes).toBe(2);
		});
	});

	describe("clear", () => {
		it("removes all entries and zeros totalBytes", () => {
			const c = new ByteLruCache(1024, 512);
			c.set("a", "1");
			c.set("b", "22");
			c.clear();
			expect(c.size).toBe(0);
			expect(c.totalBytes).toBe(0);
			expect(c.get("a")).toBeUndefined();
		});
	});

	describe("randomized invariant test", () => {
		// 決定的な手書き LCG (Numerical Recipes) でランダム操作を回す。
		// 不変条件: totalBytes <= budget、size <= 挿入回数。
		function lcg(seed: number): () => number {
			let s = seed >>> 0;
			return () => {
				s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
				return s;
			};
		}

		it("maintains totalBytes <= budget across ~1000 ops", () => {
			const BUDGET = 200;
			const c = new ByteLruCache(BUDGET, 100);
			const rng = lcg(42);
			for (let i = 0; i < 1000; i++) {
				const r = rng() % 100;
				const key = `k${r % 20}`;
				if (r < 60) {
					// set
					const sizeUnits = (rng() % 40) + 1;
					c.set(key, "a".repeat(sizeUnits));
				} else if (r < 85) {
					c.get(key);
				} else {
					c.delete(key);
				}
				expect(c.totalBytes).toBeLessThanOrEqual(BUDGET);
			}
		});
	});
});
