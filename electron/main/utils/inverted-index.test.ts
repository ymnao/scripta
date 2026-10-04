import { describe, expect, it } from "vitest";
import {
	bigramsOfLine,
	buildScanList,
	type CandidateResult,
	collectViolations,
	INDEX_ADMISSION_MAX_BYTES,
	InvertedIndex,
	verifyIndexSuperset,
} from "./inverted-index";

describe("bigramsOfLine", () => {
	it("returns empty array for empty string", () => {
		expect(bigramsOfLine("")).toEqual([]);
	});

	it("returns empty array for single character", () => {
		expect(bigramsOfLine("a")).toEqual([]);
	});

	it("decomposes ascii string into overlapping bigrams", () => {
		expect(bigramsOfLine("abcd")).toEqual(["ab", "bc", "cd"]);
	});

	it("decomposes CJK string into overlapping bigrams", () => {
		expect(bigramsOfLine("あいう")).toEqual(["あい", "いう"]);
	});
});

describe("InvertedIndex.indexFile / getCandidates basic", () => {
	it("hits a substring query after indexing a single file", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "hello world");
		const result = idx.getCandidates("hello");
		expect(result.kind).toBe("candidates");
		if (result.kind === "candidates") {
			expect(result.candidates.has("/ws/a.md")).toBe(true);
			expect(result.indexedValid.has("/ws/a.md")).toBe(true);
		}
	});

	it("computes intersection correctly across multiple files with different grams", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "foobar");
		idx.indexFile("/ws/b.md", "foobaz");
		idx.indexFile("/ws/c.md", "quux");
		const result = idx.getCandidates("fooba");
		expect(result.kind).toBe("candidates");
		if (result.kind === "candidates") {
			expect(result.candidates.has("/ws/a.md")).toBe(true);
			expect(result.candidates.has("/ws/b.md")).toBe(true);
			expect(result.candidates.has("/ws/c.md")).toBe(false);
		}
	});

	it("returns empty candidates when at least one bigram is unregistered", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "hello world");
		const result = idx.getCandidates("zzzzz");
		expect(result.kind).toBe("candidates");
		if (result.kind === "candidates") {
			expect(result.candidates.size).toBe(0);
		}
	});

	it("falls back for 1-char query, empty query, or query with newlines", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "hello world");
		expect(idx.getCandidates("h").kind).toBe("fallback");
		expect(idx.getCandidates("").kind).toBe("fallback");
		expect(idx.getCandidates("he\nllo").kind).toBe("fallback");
		expect(idx.getCandidates("he\rllo").kind).toBe("fallback");
	});
});

describe("currentEpochOf: pathToId registration side effect (Phase C stale-insert race fix)", () => {
	it("currentEpochOf は未登録 path を pathToId に登録して以降の invalidate を有効化する", () => {
		const idx = new InvertedIndex();
		// piggyback / idle fill の read 前 snapshot を模す (path はまだ index されたことがない)。
		const captured = idx.currentEpochOf("/ws/a.md");
		// read 中に modify batch が来て invalidate が呼ばれた状態。
		// 登録前は no-op だったが、登録後は fileEpoch が bump される。
		idx.invalidate("/ws/a.md");
		expect(idx.currentEpochOf("/ws/a.md")).not.toBe(captured);
		// readFile 完了後の handle.indexFile (capturedEpoch) は bump 後の current と一致せず破棄されるので、
		// InvertedIndex 単体では indexFile を通しても後段の epoch 照合で reject されるべき。
		// ここでは InvertedIndex API 単体の検証: indexFile 自身は epoch 照合しない (handle が照合する)
		// が、pathToId 登録の副作用が確実に発生していることを別方向から確認する。
		idx.indexFile("/ws/a.md", "content");
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(true);
	});

	it("currentEpochOf は既存登録済み path には副作用を持たない", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "content");
		const before = idx.currentEpochOf("/ws/a.md");
		idx.currentEpochOf("/ws/a.md"); // 再取得
		idx.currentEpochOf("/ws/a.md"); // 再取得
		expect(idx.currentEpochOf("/ws/a.md")).toBe(before);
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(true);
	});
});

describe("invalidate (.md modify)", () => {
	it("excludes file from candidates and indexedValid after invalidate", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "hello world");
		idx.invalidate("/ws/a.md");
		const result = idx.getCandidates("hello");
		expect(result.kind).toBe("candidates");
		if (result.kind === "candidates") {
			expect(result.candidates.has("/ws/a.md")).toBe(false);
			expect(result.indexedValid.has("/ws/a.md")).toBe(false);
		}
	});

	it("restores candidacy after re-indexFile", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "hello world");
		idx.invalidate("/ws/a.md");
		idx.indexFile("/ws/a.md", "hello world again");
		const result = idx.getCandidates("hello");
		expect(result.kind).toBe("candidates");
		if (result.kind === "candidates") {
			expect(result.candidates.has("/ws/a.md")).toBe(true);
		}
	});

	it("does not double-count tombstones when re-invalidating an already-stale file", () => {
		const idx = new InvertedIndex({ tombstoneRatio: 100 }); // ratio high enough to avoid auto clear
		idx.indexFile("/ws/a.md", "hello world");
		idx.invalidate("/ws/a.md");
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(false);
		// re-invalidate: already stale, tombstones should not increase further via this path
		const before = idx.indexedValidCount;
		idx.invalidate("/ws/a.md");
		expect(idx.indexedValidCount).toBe(before);
	});
});

describe("remove (.md delete)", () => {
	it("excludes file from candidates after remove", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "hello world");
		idx.remove("/ws/a.md");
		const result = idx.getCandidates("hello");
		expect(result.kind).toBe("candidates");
		if (result.kind === "candidates") {
			expect(result.candidates.has("/ws/a.md")).toBe(false);
		}
	});

	it("keeps pathToId mapping alive so re-index reuses id and epoch keeps increasing", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "hello world");
		const epochAfterIndex = idx.currentEpochOf("/ws/a.md");
		idx.remove("/ws/a.md");
		const epochAfterRemove = idx.currentEpochOf("/ws/a.md");
		expect(epochAfterRemove).toBeGreaterThan(epochAfterIndex);
		idx.indexFile("/ws/a.md", "hello world again");
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(true);
		const result = idx.getCandidates("hello");
		expect(result.kind).toBe("candidates");
		if (result.kind === "candidates") {
			expect(result.candidates.has("/ws/a.md")).toBe(true);
		}
	});
});

describe("invalidatePrefix", () => {
	it("invalidates exact match", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/foo", "hello world");
		const removed = idx.invalidatePrefix("/ws/foo");
		expect(removed).toBeGreaterThanOrEqual(1);
		expect(idx.isIndexedAndValid("/ws/foo")).toBe(false);
	});

	it("invalidates all files under subtree (prefix + sep)", () => {
		// tombstoneRatio を高く設定し、tombstone 全 clear の副作用と prefix 判定ロジックを分離する。
		const idx = new InvertedIndex({ tombstoneRatio: 100 });
		idx.indexFile("/ws/foo/a.md", "hello world");
		idx.indexFile("/ws/foo/b.md", "hello world");
		idx.indexFile("/ws/other.md", "hello world");
		idx.invalidatePrefix("/ws/foo");
		expect(idx.isIndexedAndValid("/ws/foo/a.md")).toBe(false);
		expect(idx.isIndexedAndValid("/ws/foo/b.md")).toBe(false);
		expect(idx.isIndexedAndValid("/ws/other.md")).toBe(true);
	});

	it("does not falsely match /foo against /foobar", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/foo", "hello world");
		idx.indexFile("/foobar", "hello world");
		idx.indexFile("/foobar/a.md", "hello world");
		idx.invalidatePrefix("/foo");
		expect(idx.isIndexedAndValid("/foo")).toBe(false);
		expect(idx.isIndexedAndValid("/foobar")).toBe(true);
		expect(idx.isIndexedAndValid("/foobar/a.md")).toBe(true);
	});
});

describe("admission cutoff", () => {
	it("rejects oversized text: posting not added, not in indexedValid", () => {
		const idx = new InvertedIndex({ admissionMaxBytes: 100 });
		const big = "a".repeat(200); // charge = 400 > 100
		idx.indexFile("/ws/big.md", big);
		expect(idx.isIndexedAndValid("/ws/big.md")).toBe(false);
		const result = idx.getCandidates("aa");
		expect(result.kind).toBe("candidates");
		if (result.kind === "candidates") {
			expect(result.indexedValid.has("/ws/big.md")).toBe(false);
			expect(result.candidates.has("/ws/big.md")).toBe(false);
		}
	});

	it("removes existing posting/indexed state when file grows past cutoff", () => {
		const idx = new InvertedIndex({ admissionMaxBytes: 100 });
		idx.indexFile("/ws/a.md", "hello"); // small, accepted
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(true);
		const before = idx.getCandidates("he");
		expect(before.kind).toBe("candidates");
		if (before.kind === "candidates") {
			expect(before.candidates.has("/ws/a.md")).toBe(true);
		}
		idx.indexFile("/ws/a.md", "a".repeat(200)); // grows past cutoff, rejected
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(false);
		const after = idx.getCandidates("he");
		expect(after.kind).toBe("candidates");
		if (after.kind === "candidates") {
			// old posting for "he" must be gone too
			expect(after.candidates.has("/ws/a.md")).toBe(false);
		}
	});

	it("rejects text whose lowercase form is longer than the cutoff even though the raw length fits", () => {
		const idx = new InvertedIndex({ admissionMaxBytes: 100 });
		const text = "İ".repeat(30); // raw charge 60 <= 100, lowercase charge 120 > 100
		expect(text.toLowerCase().length).toBe(60);
		idx.indexFile("/ws/a.md", text);
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(false);
		expect(idx.gramCount).toBe(0);
	});
});

describe("tombstone full clear", () => {
	it("auto-clears when tombstone ratio exceeds 50% after invalidating 6 of 10 files", () => {
		const idx = new InvertedIndex();
		for (let i = 0; i < 10; i++) {
			idx.indexFile(`/ws/f${i}.md`, `unique content number ${i}`);
		}
		expect(idx.indexedValidCount).toBe(10);
		for (let i = 0; i < 6; i++) {
			idx.invalidate(`/ws/f${i}.md`);
		}
		expect(idx.gramCount).toBe(0);
		expect(idx.indexedValidCount).toBe(0);
	});

	it("resets gramCount and indexedValidCount to 0 after clear", () => {
		const idx = new InvertedIndex();
		for (let i = 0; i < 10; i++) {
			idx.indexFile(`/ws/f${i}.md`, `unique content number ${i}`);
		}
		for (let i = 0; i < 6; i++) {
			idx.invalidate(`/ws/f${i}.md`);
		}
		expect(idx.gramCount).toBe(0);
		expect(idx.indexedValidCount).toBe(0);
	});
});

function candidatesOf(
	idx: InvertedIndex,
	query: string,
): { candidates: Set<string>; indexedValid: Set<string> } {
	const r = idx.getCandidates(query);
	if (r.kind !== "candidates") throw new Error(`expected candidates, got ${r.kind}`);
	return r;
}

describe("gram count ceiling (#589 B1)", () => {
	it("rejects a file whose new grams would exceed the max, leaving existing files and gramCount untouched", () => {
		const idx = new InvertedIndex({ maxGramCount: 4 });
		idx.indexFile("/ws/a.md", "abcd"); // ab bc cd
		idx.indexFile("/ws/b.md", "wxyz"); // wx xy yz → 6 > 4
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(true);
		expect(idx.isIndexedAndValid("/ws/b.md")).toBe(false);
		expect(idx.gramCount).toBe(3);
	});

	it("accepts a file that lands exactly on the max", () => {
		const idx = new InvertedIndex({ maxGramCount: 3 });
		idx.indexFile("/ws/a.md", "abcd"); // 3 grams
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(true);
		expect(idx.gramCount).toBe(3);
		expect(idx.isSaturated).toBe(false);
	});

	it("does not count grams already present in the index as new", () => {
		const idx = new InvertedIndex({ maxGramCount: 4 });
		idx.indexFile("/ws/a.md", "abcd"); // ab bc cd
		idx.indexFile("/ws/b.md", "abcdx"); // ab bc cd dx → only dx is new (3 + 1 = 4)
		expect(idx.isIndexedAndValid("/ws/b.md")).toBe(true);
		expect(idx.gramCount).toBe(4);
	});

	it("judges a re-index against the size after removing the file's own old postings", () => {
		const idx = new InvertedIndex({ maxGramCount: 3 });
		idx.indexFile("/ws/a.md", "abcd"); // ab bc cd
		idx.indexFile("/ws/a.md", "wxyz"); // wx xy yz — fits only once a's old grams are gone
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(true);
		expect(candidatesOf(idx, "wx").candidates.has("/ws/a.md")).toBe(true);
	});

	it("drops a previously valid file from indexedValid and candidates when its update is rejected", () => {
		const idx = new InvertedIndex({ maxGramCount: 3 });
		idx.indexFile("/ws/a.md", "abcd");
		idx.indexFile("/ws/a.md", "abcdefgh"); // 7 grams → rejected
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(false);
		const r = candidatesOf(idx, "ab");
		expect(r.indexedValid.has("/ws/a.md")).toBe(false);
		expect(r.candidates.has("/ws/a.md")).toBe(false);
	});

	it("sets saturated on reject and keeps answering with candidates instead of fallback", () => {
		const idx = new InvertedIndex({ maxGramCount: 3 });
		idx.indexFile("/ws/a.md", "abcd");
		expect(idx.isSaturated).toBe(false);
		idx.indexFile("/ws/b.md", "wxyz");
		expect(idx.isSaturated).toBe(true);
		expect(candidatesOf(idx, "ab").candidates.has("/ws/a.md")).toBe(true);
	});

	it("stays saturated through an invalidate until the tombstone ratio forces a clear", () => {
		const idx = new InvertedIndex({ maxGramCount: 3 });
		idx.indexFile("/ws/a.md", "abcd"); // ab bc cd
		idx.indexFile("/ws/c.md", "abc"); // existing grams only
		idx.indexFile("/ws/d.md", "bcd"); // existing grams only
		idx.indexFile("/ws/b.md", "wxyz");
		expect(idx.isSaturated).toBe(true);
		idx.invalidate("/ws/a.md"); // valid 2, tombstones 1: no clear yet
		expect(idx.isSaturated).toBe(true);
		idx.invalidate("/ws/c.md"); // valid 1, tombstones 2 → full clear
		expect(idx.gramCount).toBe(0);
		expect(idx.isSaturated).toBe(false);
	});

	it("does not stay saturated when the rejecting update itself triggers a tombstone clear", () => {
		const idx = new InvertedIndex({ maxGramCount: 3 });
		idx.indexFile("/ws/a.md", "abcd"); // ab bc cd
		idx.indexFile("/ws/b.md", "ab");
		idx.indexFile("/ws/c.md", "bc");
		idx.invalidate("/ws/c.md"); // valid 2, tombstones 1: no clear yet
		idx.indexFile("/ws/a.md", "wxyz"); // rejected; a leaves valid → tombstones 1 > 0.5 → clear
		expect(idx.gramCount).toBe(0);
		expect(idx.isSaturated).toBe(false);
	});

	it("keeps saturated while no capacity has been freed", () => {
		const idx = new InvertedIndex({ maxGramCount: 3 });
		idx.indexFile("/ws/a.md", "abcd");
		idx.indexFile("/ws/b.md", "wxyz");
		idx.indexFile("/ws/c.md", "efgh");
		expect(idx.isSaturated).toBe(true);
	});

	it("clears saturated on tombstone clear", () => {
		const idx = new InvertedIndex({ maxGramCount: 3 });
		idx.indexFile("/ws/a.md", "abcd");
		idx.indexFile("/ws/b.md", "wxyz");
		expect(idx.isSaturated).toBe(true);
		idx.invalidate("/ws/a.md"); // tombstone ratio exceeded → full clear
		expect(idx.gramCount).toBe(0);
		expect(idx.isSaturated).toBe(false);
	});
});

describe("path count cap (#589 B2)", () => {
	it("reclaims ids without indexedEpoch and keeps valid files when a new path hits the cap", () => {
		const idx = new InvertedIndex({ maxPathCount: 2 });
		idx.indexFile("/ws/a.md", "hello");
		idx.currentEpochOf("/ws/b.md"); // registered only
		const grams = idx.gramCount;
		idx.indexFile("/ws/c.md", "fresh");
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(true);
		expect(idx.isIndexedAndValid("/ws/c.md")).toBe(true);
		expect(idx.indexedValidCount).toBe(2);
		expect(idx.gramCount).toBeGreaterThan(grams);
		expect(idx.isSaturated).toBe(false);
		expect(candidatesOf(idx, "hello").candidates.has("/ws/a.md")).toBe(true);
	});

	it("reclaims a removed file whose posting remains, and a re-created file of the same name is indexed afresh", () => {
		const idx = new InvertedIndex({ maxPathCount: 2, tombstoneRatio: 100 });
		idx.indexFile("/ws/a.md", "hello");
		idx.indexFile("/ws/x.md", "other");
		idx.remove("/ws/a.md"); // posting of a stays until a tombstone clear
		idx.currentEpochOf("/ws/b.md"); // reclaims a
		expect(candidatesOf(idx, "he").candidates.has("/ws/a.md")).toBe(false);
		idx.indexFile("/ws/a.md", "world");
		expect(idx.indexedValidCount).toBe(2);
		const r = candidatesOf(idx, "he");
		expect(r.candidates.has("/ws/a.md")).toBe(false);
		expect(candidatesOf(idx, "wo").candidates.has("/ws/a.md")).toBe(true);
	});

	it("keeps the epoch of a surviving file unchanged across reclamation", () => {
		const idx = new InvertedIndex({ maxPathCount: 2 });
		idx.indexFile("/ws/a.md", "hello");
		const before = idx.currentEpochOf("/ws/a.md");
		idx.currentEpochOf("/ws/b.md");
		idx.currentEpochOf("/ws/c.md"); // reclaims b
		expect(idx.currentEpochOf("/ws/a.md")).toBe(before);
	});

	it("never lets an epoch captured before reclamation match afterwards (stale-insert race)", () => {
		const idx = new InvertedIndex({ maxPathCount: 2 });
		const p = "/ws/p.md";
		const e0 = idx.currentEpochOf(p);
		idx.currentEpochOf("/ws/q.md");
		idx.currentEpochOf("/ws/r.md"); // reclaims p and q
		expect(idx.currentEpochOf(p)).not.toBe(e0);
	});

	it("refuses new paths and saturates when less than half of the cap is reclaimable", () => {
		const idx = new InvertedIndex({ maxPathCount: 2, tombstoneRatio: 100 });
		idx.indexFile("/ws/a.md", "hello");
		idx.indexFile("/ws/b.md", "world");
		idx.indexFile("/ws/c.md", "fresh");
		expect(idx.isIndexedAndValid("/ws/c.md")).toBe(false);
		expect(idx.isSaturated).toBe(true);
		expect(idx.isIndexedAndValid("/ws/a.md")).toBe(true);
		expect(idx.isIndexedAndValid("/ws/b.md")).toBe(true);
	});

	it("reports the same epoch for a refused path until it can be registered", () => {
		const idx = new InvertedIndex({ maxPathCount: 2, tombstoneRatio: 100 });
		idx.indexFile("/ws/a.md", "hello");
		idx.indexFile("/ws/b.md", "world");
		expect(idx.currentEpochOf("/ws/c.md")).toBe(idx.currentEpochOf("/ws/c.md"));
	});

	it("registers again after a tombstone clear, with an epoch different from the refused one", () => {
		const idx = new InvertedIndex({ maxPathCount: 2 });
		idx.indexFile("/ws/a.md", "hello");
		idx.indexFile("/ws/b.md", "world");
		const refused = idx.currentEpochOf("/ws/c.md");
		expect(idx.isSaturated).toBe(true);
		idx.invalidate("/ws/a.md"); // tombstone ratio exceeded → full clear
		expect(idx.isSaturated).toBe(false);
		expect(idx.currentEpochOf("/ws/c.md")).not.toBe(refused);
		idx.indexFile("/ws/c.md", "fresh");
		expect(idx.isIndexedAndValid("/ws/c.md")).toBe(true);
	});

	it("hands out strictly increasing epochs across different paths", () => {
		const idx = new InvertedIndex();
		const paths = ["/ws/a.md", "/ws/b.md", "/ws/c.md"];
		for (const p of paths) idx.currentEpochOf(p);
		const seen: number[] = [];
		for (const p of [paths[0], paths[1], paths[0], paths[2], paths[1]]) {
			idx.invalidate(p);
			const e = idx.currentEpochOf(p);
			for (const prev of seen) expect(e).toBeGreaterThan(prev);
			seen.push(e);
		}
	});

	it("does not reclaim on invalidate / remove / invalidatePrefix of unknown paths at the cap", () => {
		const idx = new InvertedIndex({ maxPathCount: 2, tombstoneRatio: 100 });
		idx.indexFile("/ws/a.md", "hello");
		// b は登録のみ = 回収対象。回収が走れば floor が進み、b の epoch が変わる。
		const eb = idx.currentEpochOf("/ws/b.md");
		idx.invalidate("/ws/unknown.md");
		idx.remove("/ws/unknown.md");
		expect(idx.invalidatePrefix("/ws/unknown-dir")).toBe(0);
		expect(idx.currentEpochOf("/ws/b.md")).toBe(eb);
	});
});

describe("verifyIndexSuperset", () => {
	it("does not throw when all hits are within the allowed set", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "hello world");
		idx.indexFile("/ws/b.md", "goodbye world");
		verifyIndexSuperset(idx, "hello", false, ["/ws/a.md", "/ws/b.md"], ["/ws/a.md"]);
	});

	it("throws when a hit file is not part of the candidate set", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "hello world");
		idx.indexFile("/ws/b.md", "goodbye world");
		expect(() =>
			verifyIndexSuperset(idx, "hello", false, ["/ws/a.md", "/ws/b.md"], ["/ws/b.md"]),
		).toThrow();
	});
});

describe("randomized property test (LCG-seeded)", () => {
	// 決定的な手書き LCG (Numerical Recipes)。content-cache-pure.test.ts と同一パターン。
	function lcg(seed: number): () => number {
		let s = seed >>> 0;
		return () => {
			s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
			return s;
		};
	}

	const CJK_CHARS = "あいうえおかきくけこさしすせそたちつてとなにぬねの";
	const ASCII_CHARS = "abcdefghijklmnopqrstuvwxyz";

	function randomDoc(rng: () => number): string {
		const len = 100 + (rng() % 400);
		let out = "";
		for (let i = 0; i < len; i++) {
			const useCjk = rng() % 3 === 0;
			if (useCjk) {
				out += CJK_CHARS[rng() % CJK_CHARS.length];
			} else {
				out += ASCII_CHARS[rng() % ASCII_CHARS.length];
			}
			// occasionally insert a line break
			if (rng() % 20 === 0) out += "\n";
		}
		return out;
	}

	function naiveScan(docs: ReadonlyMap<string, string>, queryLower: string): string[] {
		const hits: string[] = [];
		for (const [path, text] of docs) {
			if (text.toLowerCase().includes(queryLower)) hits.push(path);
		}
		return hits;
	}

	function buildDocsAndQueries(seed: number): { docs: Map<string, string>; queries: string[] } {
		const rng = lcg(seed);
		const docs = new Map<string, string>();
		const docCount = 20 + (rng() % 11); // 20-30
		for (let i = 0; i < docCount; i++) {
			docs.set(`/ws/doc${i}.md`, randomDoc(rng));
		}
		const docTexts = [...docs.values()];
		const queries: string[] = [];
		for (let i = 0; i < 100; i++) {
			// pick a random doc, cut a random substring (length 2-5)
			const doc = docTexts[rng() % docTexts.length];
			if (doc.length < 2) continue;
			const start = rng() % (doc.length - 1);
			const len = 2 + (rng() % 4);
			const sub = doc.slice(start, Math.min(doc.length, start + len));
			if (sub.length >= 2 && !sub.includes("\n") && !sub.includes("\r")) {
				queries.push(sub.toLowerCase());
			}
		}
		return { docs, queries };
	}

	it("holds the superset invariant when all documents are fully indexed", () => {
		const { docs, queries } = buildDocsAndQueries(1001);
		const idx = new InvertedIndex();
		for (const [path, text] of docs) {
			idx.indexFile(path, text);
		}
		const allPaths = [...docs.keys()];
		for (const q of queries) {
			const hits = naiveScan(docs, q);
			expect(() => verifyIndexSuperset(idx, q, false, allPaths, hits)).not.toThrow();
		}
	});

	it("holds the superset invariant after 20% random invalidation", () => {
		const { docs, queries } = buildDocsAndQueries(2002);
		const idx = new InvertedIndex();
		for (const [path, text] of docs) {
			idx.indexFile(path, text);
		}
		const rng = lcg(9999);
		const allPaths = [...docs.keys()];
		for (const path of allPaths) {
			if (rng() % 5 === 0) idx.invalidate(path);
		}
		for (const q of queries) {
			const hits = naiveScan(docs, q);
			expect(() => verifyIndexSuperset(idx, q, false, allPaths, hits)).not.toThrow();
		}
	});

	it("holds the superset invariant when only part of the docs are indexed", () => {
		const { docs, queries } = buildDocsAndQueries(3003);
		const idx = new InvertedIndex();
		const allPaths = [...docs.keys()];
		// only index the first half; the rest are never indexed (unindexed, must fallback to allowed)
		const half = Math.floor(allPaths.length / 2);
		for (let i = 0; i < half; i++) {
			const path = allPaths[i];
			idx.indexFile(path, docs.get(path) as string);
		}
		for (const q of queries) {
			const hits = naiveScan(docs, q);
			expect(() => verifyIndexSuperset(idx, q, false, allPaths, hits)).not.toThrow();
		}
	});
});

describe("buildScanList", () => {
	const io = ["/ws/a.md", "/ws/b.md", "/ws/c.md", "/ws/d.md"];
	const inp = ["/base/a.md", "/base/b.md", "/base/c.md", "/base/d.md"];

	it("passes all files through when cand kind is fallback", () => {
		const cand: CandidateResult = { kind: "fallback" };
		const { ioScan, inScan } = buildScanList(io, inp, cand);
		expect(ioScan).toEqual(io);
		expect(inScan).toEqual(inp);
	});

	it("returns candidates ∪ (allIoFiles \\ indexedValid) with original order", () => {
		const cand: CandidateResult = {
			kind: "candidates",
			candidates: new Set(["/ws/a.md"]),
			indexedValid: new Set(["/ws/a.md", "/ws/b.md", "/ws/c.md"]),
			// d.md は未 indexed (indexedValid にない) → 必ず含まれる
			// a.md は候補 → 含まれる、b.md/c.md は valid かつ非候補 → 除外
		};
		const { ioScan, inScan } = buildScanList(io, inp, cand);
		expect(ioScan).toEqual(["/ws/a.md", "/ws/d.md"]);
		expect(inScan).toEqual(["/base/a.md", "/base/d.md"]);
	});

	it("returns empty when candidates=∅ and all files are indexedValid", () => {
		const cand: CandidateResult = {
			kind: "candidates",
			candidates: new Set(),
			indexedValid: new Set(io),
		};
		const { ioScan, inScan } = buildScanList(io, inp, cand);
		expect(ioScan).toEqual([]);
		expect(inScan).toEqual([]);
	});

	it("returns all files when indexedValid=∅ regardless of candidates content", () => {
		// 未 indexed 集合が全 file なので fallback 集合として全 file を通す
		const cand: CandidateResult = {
			kind: "candidates",
			candidates: new Set(),
			indexedValid: new Set(),
		};
		const { ioScan, inScan } = buildScanList(io, inp, cand);
		expect(ioScan).toEqual(io);
		expect(inScan).toEqual(inp);
	});

	it("preserves parallel index alignment between ioFiles and inFiles", () => {
		const cand: CandidateResult = {
			kind: "candidates",
			candidates: new Set(["/ws/c.md"]),
			indexedValid: new Set(io),
		};
		const { ioScan, inScan } = buildScanList(io, inp, cand);
		expect(ioScan).toEqual(["/ws/c.md"]);
		expect(inScan).toEqual(["/base/c.md"]);
	});
});

describe("collectViolations", () => {
	it("returns null when getCandidates returns fallback (query < 2 chars)", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "hello world");
		expect(collectViolations(idx, "a", ["/ws/a.md"], ["/ws/a.md"])).toBeNull();
	});

	it("returns empty array when all hits are eligible (candidates 或は未 indexed)", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "quickbrown");
		idx.indexFile("/ws/b.md", "unrelated");
		// hit=a.md は candidates に含まれるので violation なし
		const v = collectViolations(idx, "quick", ["/ws/a.md", "/ws/b.md"], ["/ws/a.md"]);
		expect(v).toEqual([]);
	});

	it("returns hit files that are indexed valid but not candidates (真の superset 破損 の検出)", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "quickbrown");
		idx.indexFile("/ws/b.md", "unrelated");
		// b.md は indexed valid だが query "quick" の候補に入らない。
		// もし truth が b.md を hit と主張 (実際にはあり得ないが violation シナリオ)、violation 検出。
		const v = collectViolations(idx, "quick", ["/ws/a.md", "/ws/b.md"], ["/ws/b.md"]);
		expect(v).toEqual(["/ws/b.md"]);
	});

	it("returns empty when hit is indexed 未 valid (invalidated) — eligible via fallback", () => {
		const idx = new InvertedIndex();
		idx.indexFile("/ws/a.md", "quickbrown");
		idx.invalidate("/ws/a.md"); // fileEpoch bump → indexed 未 valid
		// a.md は indexedValid から外れる = allowed 集合の未 indexed 部分に入る = 違反にはならない
		const v = collectViolations(idx, "quick", ["/ws/a.md"], ["/ws/a.md"]);
		expect(v).toEqual([]);
	});
});

// admission constant を直接使う regression: import が生きていることの sanity check。
describe("INDEX_ADMISSION_MAX_BYTES sanity", () => {
	it("default admission cutoff matches the exported constant", () => {
		const idx = new InvertedIndex();
		const overLimitLen = INDEX_ADMISSION_MAX_BYTES / 2 + 1; // charge = *2 > MAX_BYTES
		idx.indexFile("/ws/huge.md", "a".repeat(overLimitLen));
		expect(idx.isIndexedAndValid("/ws/huge.md")).toBe(false);
	});
});
