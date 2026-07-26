// @vitest-environment node
// resolveDarkAssertViolations (#405) の分岐網羅。dark assert の retry / verdict 段は
// 従来 e2e 1 spec (search-l3.electron.spec.ts) のみが頼りで、round 1 の stillUnindexed
// dead code のような regression を検出できなかった (#405 Finding 3)。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import {
	type DarkAssertRetryDeps,
	formatDarkAssertReport,
	resolveDarkAssertViolations,
} from "./search";

const ALL_IO = ["/ws/a.md", "/ws/b.md"] as const;

interface FakeOptions {
	/**
	 * collectViolations の戻り値。呼び出しごとの truth hits を受け取るので、
	 * 「drop が 2 回目に反映されるか」も「1 回目だけ violation を返す」も同じ 1 経路で書ける。
	 * null は fallback (判定 skip)。
	 */
	violationsFromTruth: (hits: readonly string[]) => string[] | null;
	texts?: Map<string, string | null>;
	authorized?: (p: string) => boolean;
	staleAfterCalls?: number;
	/**
	 * path ごとの currentEpochOf 戻り値を呼び出し順に並べたもの (#410 の epoch 変化シミュレート)。
	 * 末尾に達したら最後の値を返し続ける。未指定 path / opts 省略時は常に 1 (従来の固定 fake)。
	 */
	epochs?: Map<string, number[]>;
}

/** 1 回目だけ violations を返し 2 回目以降は空を返す scripted 版 (reindex で解消するケース用)。 */
function resolvedOnRetry(first: string[] | null): (hits: readonly string[]) => string[] | null {
	let call = 0;
	return () => (call++ === 0 ? first : []);
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
	const epochCalls = new Map<string, number>();
	let staleChecks = 0;
	const deps: DarkAssertRetryDeps = {
		collectViolations: (_q, _all, hits) => {
			collectArgs.push([...hits]);
			return opts.violationsFromTruth(hits);
		},
		isRealPathAllowed: async (p) => {
			calls.push(`auth:${p}`);
			return opts.authorized?.(p) ?? true;
		},
		currentEpochOf: (p) => {
			calls.push(`epoch:${p}`);
			const seq = opts.epochs?.get(p);
			if (seq === undefined || seq.length === 0) return 1;
			const i = epochCalls.get(p) ?? 0;
			epochCalls.set(p, i + 1);
			return seq[Math.min(i, seq.length - 1)];
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
		const { deps, calls } = makeFakeDeps({ violationsFromTruth: () => [] });
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({ kind: "ok" });
		// retry loop に入らないので I/O は一切走らない
		expect(calls).toEqual([]);
	});

	it("returns ok when collectViolations returns null (fallback / 判定 skip)", async () => {
		const { deps } = makeFakeDeps({ violationsFromTruth: () => null });
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({ kind: "ok" });
	});

	it("returns resolved when reindex clears the violation (watcher-latency window)", async () => {
		const { deps, indexed } = makeFakeDeps({
			violationsFromTruth: resolvedOnRetry(["/ws/a.md"]),
			texts: new Map([["/ws/a.md", "hello foo world"]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		// fresh text は query を含むので truth は保持されたまま (drop 0)
		expect(verdict).toEqual({
			kind: "resolved",
			dropped: { staleTruth: 0, unauthorized: 0, unreadable: 0 },
		});
		expect(indexed).toEqual([{ path: "/ws/a.md", text: "hello foo world", epoch: 1 }]);
	});

	it("captures the epoch before reading the file (piggyback / idle-fill と同順序)", async () => {
		// 逆順にすると bump 後の epoch で stale text が valid 化する race を assert 自身が作る
		// (Phase D round 1 Fable W1)。順序を test で恒久 guard する。
		// #410 で capture 位置を認可判定より前へ移した (drop する file にも検証済みマークを付けるため)。
		// 本 test が守る不変条件は「epoch capture が read より前」であり、それは維持されている。
		const { deps, calls } = makeFakeDeps({
			violationsFromTruth: resolvedOnRetry(["/ws/a.md"]),
			texts: new Map([["/ws/a.md", "foo"]]),
		});
		await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(calls).toEqual(["epoch:/ws/a.md", "auth:/ws/a.md", "read:/ws/a.md", "index:/ws/a.md"]);
		expect(calls.indexOf("epoch:/ws/a.md")).toBeLessThan(calls.indexOf("read:/ws/a.md"));
	});

	it("drops a truth hit whose fresh text no longer contains the query (Finding 1 の FP)", async () => {
		// truth pass 読取後に file が正当に書き換わったケース。従来は reindex しても violation が
		// 残り「真の破損」として throw していた。
		const { deps, collectArgs } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", "no longer matching"]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({
			kind: "resolved",
			dropped: { staleTruth: 1, unauthorized: 0, unreadable: 0 },
		});
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
		expect(verdict).toEqual({
			kind: "resolved",
			dropped: { staleTruth: 0, unauthorized: 0, unreadable: 1 },
		});
		expect(indexed).toEqual([]);
	});

	it("drops an unauthorized truth hit without reading or indexing it", async () => {
		const { deps, calls, indexed } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			authorized: () => false,
			texts: new Map([["/ws/a.md", "foo"]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({
			kind: "resolved",
			dropped: { staleTruth: 0, unauthorized: 1, unreadable: 0 },
		});
		// epoch は認可判定より前に 1 度だけ capture される (drop 済み file の二重カウント防止マーク)。
		expect(calls).toEqual(["epoch:/ws/a.md", "auth:/ws/a.md"]);
		expect(indexed).toEqual([]);
	});

	it("returns violated when the fresh text still hits but stays outside the candidate set", async () => {
		// 真の superset 破損 (bigram 抽出バグ等)。fresh text が query を含む = truth は drop されない。
		const { deps } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", "still contains foo"]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({
			kind: "violated",
			violations: ["/ws/a.md"],
			dropped: { staleTruth: 0, unauthorized: 0, unreadable: 0 },
		});
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
		expect(verdict).toEqual({
			kind: "violated",
			violations: ["/ws/b.md"],
			dropped: { staleTruth: 1, unauthorized: 0, unreadable: 0 },
		});
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
			violationsFromTruth: resolvedOnRetry(["/ws/a.md"]),
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
		expect(verdict).toEqual({
			kind: "violated",
			violations: ["/ws/a.md"],
			dropped: { staleTruth: 0, unauthorized: 0, unreadable: 0 },
		});
	});

	it("returns stale when superseded after the retry loop but before the recheck", async () => {
		// staleAfterCalls: 1 → loop 内の check は通過し、loop 後の final check で stale 化する。
		// drop 済み truth を抱えたまま verdict を下さない cancel semantics の固定。
		const { deps } = makeFakeDeps({
			violationsFromTruth: resolvedOnRetry(["/ws/a.md"]),
			texts: new Map([["/ws/a.md", "foo"]]),
			staleAfterCalls: 1,
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({ kind: "stale" });
	});

	it("verifies a violation that first appears in the recheck instead of throwing on it", async () => {
		// retry 中に idle fill 等が並走して別 file を indexedValid 化すると、その file は
		// recheck で初めて violation として現れる。未検証のまま throw すると Finding 1 と
		// 同型の FP が recheck の入口から入るため、次周で 1 度だけ検証する。
		let call = 0;
		const { deps, calls } = makeFakeDeps({
			violationsFromTruth: () => {
				call++;
				if (call === 1) return ["/ws/a.md"];
				if (call === 2) return ["/ws/b.md"];
				return [];
			},
			texts: new Map([
				["/ws/a.md", "foo"],
				["/ws/b.md", "rewritten"],
			]),
		});
		const verdict = await resolveDarkAssertViolations(
			"foo",
			ALL_IO,
			new Set(["/ws/a.md", "/ws/b.md"]),
			deps,
		);
		expect(verdict).toEqual({
			kind: "resolved",
			dropped: { staleTruth: 1, unauthorized: 0, unreadable: 0 },
		});
		expect(calls).toEqual([
			"epoch:/ws/a.md",
			"auth:/ws/a.md",
			"read:/ws/a.md",
			"index:/ws/a.md",
			"epoch:/ws/b.md",
			"auth:/ws/b.md",
			"read:/ws/b.md",
			"index:/ws/b.md",
		]);
	});

	it("verifies each file at most once while its epoch stays put", async () => {
		// 同じ file が recheck でも violation のまま残り、epoch も動いていない = fresh text が
		// query を含むのに候補外。再検証を繰り返さず violated で確定する
		// (retry が真の破損を塗りつぶさない保証)。
		const { deps, calls } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", "foo"]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({
			kind: "violated",
			violations: ["/ws/a.md"],
			dropped: { staleTruth: 0, unauthorized: 0, unreadable: 0 },
		});
		expect(calls.filter((c) => c.startsWith("read:"))).toEqual(["read:/ws/a.md"]);
	});

	it("returns ok when the recheck falls back (index disabled mid-retry), not resolved", async () => {
		// fallback は「解消」ではなく判定不能。warn を出さない ok に倒す。
		let call = 0;
		const { deps } = makeFakeDeps({
			violationsFromTruth: () => (call++ === 0 ? ["/ws/a.md"] : null),
			texts: new Map([["/ws/a.md", "rewritten"]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({ kind: "ok" });
	});
});

describe("resolveDarkAssertViolations: 検証済み file の epoch 追跡 (#410 Finding 1)", () => {
	it("re-verifies a verified file whose epoch changed instead of declaring it violated", async () => {
		// issue #410 のシナリオ: a を検証 (epoch 1、fresh text は query を含むので truth 保持)
		// → b の readFile await 中に a が正当に書き換えられ watcher flush → idle fill が新内容で
		// 再 index → a が再び violation 化。従来は「検証済みなので再検証しない」で violated (FP)。
		// epoch を記録していれば差し戻して再検証でき、staleTruth drop として解消する。
		let call = 0;
		const texts = new Map([
			["/ws/a.md", "contains foo"],
			["/ws/b.md", "rewritten"],
		]);
		const { deps } = makeFakeDeps({
			violationsFromTruth: () => {
				call++;
				if (call === 1) return ["/ws/a.md", "/ws/b.md"];
				if (call === 2) {
					// 2 回目の collect の直前に a が書き換わった体で fresh text を差し替える。
					texts.set("/ws/a.md", "no longer matching");
					return ["/ws/a.md"];
				}
				return [];
			},
			texts,
			// a の epoch: 初回検証で 1 → 差し戻し判定で 2 (書き換え由来の bump) → 再検証以降は 2 のまま。
			epochs: new Map([["/ws/a.md", [1, 2]]]),
		});
		const verdict = await resolveDarkAssertViolations(
			"foo",
			ALL_IO,
			new Set(["/ws/a.md", "/ws/b.md"]),
			deps,
		);
		expect(verdict).toEqual({
			kind: "resolved",
			// b は初回検証で staleTruth drop、a は再検証で staleTruth drop。二重カウントは無い。
			dropped: { staleTruth: 2, unauthorized: 0, unreadable: 0 },
		});
	});

	it("returns violated when the verified file's epoch is unchanged", async () => {
		// epoch が動いていない = 検証に使った snapshot が現行。従来どおり真の破損として確定する。
		const { deps } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", "still contains foo"]]),
			epochs: new Map([["/ws/a.md", [7]]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({
			kind: "violated",
			violations: ["/ws/a.md"],
			dropped: { staleTruth: 0, unauthorized: 0, unreadable: 0 },
		});
	});

	it("still returns violated when re-verification confirms the file is genuinely missing", async () => {
		// epoch 変化 = 無条件で drop ではない。再検証しても fresh text が query を含み候補外のままなら
		// 真の破損。差し戻しが「破損の塗りつぶし」に劣化しないことの guard。
		const { deps, calls } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", "still contains foo"]]),
			epochs: new Map([["/ws/a.md", [1, 2]]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({
			kind: "violated",
			violations: ["/ws/a.md"],
			dropped: { staleTruth: 0, unauthorized: 0, unreadable: 0 },
		});
		// 差し戻しで 2 回読んでいる (1 回目 = 初回検証、2 回目 = epoch 変化後の再検証)。
		expect(calls.filter((c) => c.startsWith("read:"))).toEqual(["read:/ws/a.md", "read:/ws/a.md"]);
	});

	it("returns exhausted (not violated) when the epoch keeps churning", async () => {
		// 持続的な書き換えで epoch が動き続けるケース。throw すると塞いだはずの FP を再導入するので
		// 判定不能として打ち切る。上限が無いと無限ループになる。
		const { deps, calls } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", "still contains foo"]]),
			epochs: new Map([["/ws/a.md", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict).toEqual({
			kind: "exhausted",
			violations: ["/ws/a.md"],
			rounds: 3,
			dropped: { staleTruth: 0, unauthorized: 0, unreadable: 0 },
		});
		// 実際の再検証回数も pin する: 初回検証 1 + 差し戻し 3 = 4 read。
		expect(calls.filter((c) => c.startsWith("read:"))).toHaveLength(4);
	});

	it("still reports the epoch-stable violation when another file churns past the budget", async () => {
		// churn する file が 1 つあるだけで同じ round の真の破損まで warn に丸めると、
		// dev-monitor が本来検出すべき破損を見逃す。安定分は violated として報告する。
		const { deps } = makeFakeDeps({
			violationsFromTruth: (hits) => [...hits],
			texts: new Map([
				["/ws/a.md", "still contains foo"],
				["/ws/b.md", "still contains foo"],
			]),
			// a は epoch 安定、b は毎回変化して budget を食い潰す。
			epochs: new Map([
				["/ws/a.md", [1]],
				["/ws/b.md", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
			]),
		});
		const verdict = await resolveDarkAssertViolations(
			"foo",
			ALL_IO,
			new Set(["/ws/a.md", "/ws/b.md"]),
			deps,
		);
		expect(verdict).toEqual({
			kind: "violated",
			violations: ["/ws/a.md"],
			dropped: { staleTruth: 0, unauthorized: 0, unreadable: 0 },
		});
	});

	it("records the epoch captured before the read, not one re-read after indexFile", async () => {
		// indexFile 後に取り直すと、capture→read 間の invalidate で indexFile が no-op になった
		// ケースでも「現行 epoch で検証済み」に見えて差し戻しが効かなくなる。
		// epoch 呼び出しを file あたり「検証時 1 回 + violated 確定判定 1 回」に固定して記録元を縛る。
		const { deps, calls } = makeFakeDeps({
			violationsFromTruth: (hits) => hits.filter((h) => h === "/ws/a.md"),
			texts: new Map([["/ws/a.md", "still contains foo"]]),
			epochs: new Map([["/ws/a.md", [1, 1]]]),
		});
		const verdict = await resolveDarkAssertViolations("foo", ALL_IO, new Set(["/ws/a.md"]), deps);
		expect(verdict.kind).toBe("violated");
		expect(calls.filter((c) => c === "epoch:/ws/a.md")).toHaveLength(2);
	});
});

describe("formatDarkAssertReport (#410 Finding 2)", () => {
	const DROPPED = { staleTruth: 1, unauthorized: 2, unreadable: 3 };

	it("reports nothing for ok", () => {
		expect(formatDarkAssertReport({ kind: "ok" }, "foo")).toBeNull();
	});

	it("reports nothing for stale", () => {
		expect(formatDarkAssertReport({ kind: "stale" }, "foo")).toBeNull();
	});

	it("warns (never throws) for resolved", () => {
		const report = formatDarkAssertReport({ kind: "resolved", dropped: DROPPED }, "foo");
		expect(report?.level).toBe("warn");
		// prefix は e2e (search-l3.electron.spec.ts) の stderr filter が拾う契約。
		expect(report?.message).toContain("[dark-assert]");
		expect(report?.message).toContain('query="foo"');
		expect(report?.message).toContain("droppedTruth={stale:1,unauthorized:2,unreadable:3}");
	});

	it("warns for exhausted and carries the round count and churning file", () => {
		const report = formatDarkAssertReport(
			{ kind: "exhausted", violations: ["/ws/a.md"], dropped: DROPPED, rounds: 3 },
			"foo",
		);
		expect(report?.level).toBe("warn");
		expect(report?.message).toContain("[dark-assert]");
		expect(report?.message).toContain("rounds=3");
		expect(report?.message).toContain("/ws/a.md");
	});

	it("throws for violated and names the first offending file", () => {
		const report = formatDarkAssertReport(
			{ kind: "violated", violations: ["/ws/a.md", "/ws/b.md"], dropped: DROPPED },
			"foo",
		);
		expect(report?.level).toBe("throw");
		expect(report?.message).toContain("/ws/a.md");
		expect(report?.message).toContain('query="foo"');
		expect(report?.message).toContain("droppedTruth={stale:1,unauthorized:2,unreadable:3}");
	});
});
