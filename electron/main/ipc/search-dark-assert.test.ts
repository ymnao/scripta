// @vitest-environment node
// resolveDarkAssertViolations (#405) の分岐網羅。dark assert の retry / verdict 段は
// 従来 e2e 1 spec (search-l3.electron.spec.ts) のみが頼りで、round 1 の stillUnindexed
// dead code のような regression を検出できなかった (#405 Finding 3)。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { type DarkAssertRetryDeps, resolveDarkAssertViolations } from "./search";

const ALL_IO = ["/ws/a.md", "/ws/b.md"] as const;

interface FakeOptions {
	/** collectViolations の呼び出しごとの戻り値 (1 回目 / 2 回目 …)。null は fallback。 */
	violationsByCall?: Array<string[] | null>;
	/** truth 集合から実際に violation を再計算する場合に使う (drop の反映を見るテスト用)。 */
	violationsFromTruth?: (hits: readonly string[]) => string[] | null;
	texts?: Map<string, string | null>;
	authorized?: (p: string) => boolean;
	staleAfterCalls?: number;
}

function makeFakeDeps(opts: FakeOptions): {
	deps: DarkAssertRetryDeps;
	calls: string[];
	indexed: Array<{ path: string; text: string; epoch: number }>;
	collectArgs: string[][];
} {
	const calls: string[] = [];
	const indexed: Array<{ path: string; text: string; epoch: number }> = [];
	const collectArgs: string[][] = [];
	let collectCount = 0;
	let staleChecks = 0;
	const deps: DarkAssertRetryDeps = {
		collectViolations: (_q, _all, hits) => {
			collectArgs.push([...hits]);
			if (opts.violationsFromTruth !== undefined) return opts.violationsFromTruth(hits);
			const v = opts.violationsByCall?.[collectCount] ?? [];
			collectCount++;
			return v;
		},
		isAuthorized: async (p) => {
			calls.push(`auth:${p}`);
			return opts.authorized?.(p) ?? true;
		},
		currentEpochOf: (p) => {
			calls.push(`epoch:${p}`);
			return 1;
		},
		readFile: async (p) => {
			calls.push(`read:${p}`);
			return opts.texts?.get(p) ?? null;
		},
		indexFile: (p, text, epoch) => {
			calls.push(`index:${p}`);
			indexed.push({ path: p, text, epoch });
		},
		isStale: () => {
			staleChecks++;
			return opts.staleAfterCalls !== undefined && staleChecks > opts.staleAfterCalls;
		},
	};
	return { deps, calls, indexed, collectArgs };
}

describe("resolveDarkAssertViolations", () => {
	it("returns ok when collectViolations reports no violation", async () => {
		const { deps, calls } = makeFakeDeps({ violationsByCall: [[]] });
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({ kind: "ok" });
		// retry loop に入らないので I/O は一切走らない
		expect(calls).toEqual([]);
	});

	it("returns ok when collectViolations returns null (fallback / 判定 skip)", async () => {
		const { deps } = makeFakeDeps({ violationsByCall: [null] });
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({ kind: "ok" });
	});

	it("returns resolved when reindex clears the violation (watcher-latency window)", async () => {
		const { deps, indexed } = makeFakeDeps({
			violationsByCall: [["/ws/a.md"], []],
			texts: new Map([["/ws/a.md", "hello foo world"]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		// fresh text は query を含むので truth は保持されたまま (drop 0)
		expect(verdict).toEqual({ kind: "resolved", droppedCount: 0 });
		expect(indexed).toEqual([{ path: "/ws/a.md", text: "hello foo world", epoch: 1 }]);
	});

	it("captures the epoch before reading the file (piggyback / idle-fill と同順序)", async () => {
		// 逆順にすると bump 後の epoch で stale text が valid 化する race を assert 自身が作る
		// (Phase D round 1 Fable W1)。順序を test で恒久 guard する。
		const { deps, calls } = makeFakeDeps({
			violationsByCall: [["/ws/a.md"], []],
			texts: new Map([["/ws/a.md", "foo"]]),
		});
		await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(calls).toEqual(["auth:/ws/a.md", "epoch:/ws/a.md", "read:/ws/a.md", "index:/ws/a.md"]);
	});

	it("drops a truth hit whose fresh text no longer contains the query (Finding 1 の FP)", async () => {
		// truth pass 読取後に file が正当に書き換わったケース。従来は reindex しても violation が
		// 残り「真の破損」として throw していた。
		const { deps, collectArgs } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", "no longer matching"]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({ kind: "resolved", droppedCount: 1 });
		// 2 回目の collectViolations には drop 後の truth (空) が渡る
		expect(collectArgs).toEqual([["/ws/a.md"], []]);
	});

	it("indexes the fresh text even when the truth hit is dropped", async () => {
		const { deps, indexed } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", "rewritten"]]),
		});
		await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(indexed).toEqual([{ path: "/ws/a.md", text: "rewritten", epoch: 1 }]);
	});

	it("drops a truth hit that can no longer be read (ENOENT 等)", async () => {
		const { deps, indexed } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", null]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({ kind: "resolved", droppedCount: 1 });
		expect(indexed).toEqual([]);
	});

	it("drops an unauthorized truth hit without reading or indexing it", async () => {
		const { deps, calls, indexed } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			authorized: () => false,
			texts: new Map([["/ws/a.md", "foo"]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({ kind: "resolved", droppedCount: 1 });
		expect(calls).toEqual(["auth:/ws/a.md"]);
		expect(indexed).toEqual([]);
	});

	it("returns violated when the fresh text still hits but stays outside the candidate set", async () => {
		// 真の superset 破損 (bigram 抽出バグ等)。fresh text が query を含む = truth は drop されない。
		const { deps } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", "still contains foo"]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({ kind: "violated", violations: ["/ws/a.md"] });
	});

	it("keeps other truth hits when only one file is dropped", async () => {
		const { deps } = makeFakeDeps({
			violationsFromTruth: (hits) => [...hits],
			texts: new Map([
				["/ws/a.md", "rewritten"],
				["/ws/b.md", "still contains foo"],
			]),
		});
		const verdict = await resolveDarkAssertViolations(
			"foo",
			ALL_IO,
			new Set(["/ws/a.md", "/ws/b.md"]),
			deps,
		);
		expect(verdict).toEqual({ kind: "violated", violations: ["/ws/b.md"] });
	});

	it("does not mutate the caller's truth set", async () => {
		const truth = new Set(["/ws/a.md"]);
		const { deps } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", "rewritten"]]),
		});
		await resolveDarkAssertViolations("foo", ALL_IO, truth, deps);
		expect([...truth]).toEqual(["/ws/a.md"]);
	});

	it("returns stale without a verdict when the search is superseded mid-retry", async () => {
		const { deps } = makeFakeDeps({
			violationsByCall: [["/ws/a.md"], []],
			texts: new Map([["/ws/a.md", "foo"]]),
			staleAfterCalls: 0,
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({ kind: "stale" });
	});

	it("matches the query case-insensitively when re-verifying fresh text", async () => {
		const { deps } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", "FOO bar"]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({ kind: "violated", violations: ["/ws/a.md"] });
	});
});
