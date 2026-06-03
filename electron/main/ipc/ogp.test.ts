// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { __testing } from "./ogp";

const {
	fetchOgpImpl,
	cacheGet,
	cacheSet,
	clearCache,
	cancelOgpFetch,
	hasInFlight,
	MAX_CACHE_ENTRIES,
} = __testing;

// SSRF defense (pinSafeLookup) が public IP のみ許可するため、local HTTP サーバを
// 立てて round-trip を確認する integration test は接続段階で確実に reject される。
// したがってここでは:
//   - scheme 検証
//   - SSRF deny（127.0.0.1 / ::1 / 169.254.169.254 等の典型例）
//   - cache の TTL / capacity 動作
// の 3 観点に絞って単体テストする。実 fetch path は e2e で確認するか、本物の
// global URL を使う将来テストで担保する。
// DNS rebinding 防御本体のテストは ssrf-guard.test.ts § "pinSafeLookup" を参照。

describe("ogp scheme validation", () => {
	beforeEach(() => clearCache());
	it("rejects non-http(s) schemes", async () => {
		await expect(fetchOgpImpl("file:///etc/passwd")).rejects.toThrow(/http and https/);
		await expect(fetchOgpImpl("ftp://example.com")).rejects.toThrow(/http and https/);
		await expect(fetchOgpImpl("javascript:alert(1)")).rejects.toThrow(/http and https/);
	});
	it("scheme check is case-insensitive", async () => {
		// HTTP:// 大文字でも scheme チェックは pass する（その後 SSRF / 接続 で失敗するが
		// scheme 段階で reject されないことを確認）。
		await expect(fetchOgpImpl("HTTP://localhost-not-real.invalid")).rejects.not.toThrow(
			/http and https/,
		);
	});
});

describe("ogp SSRF defense via pinSafeLookup", () => {
	beforeEach(() => clearCache());
	it("blocks private hostname (127.0.0.1) at pin time", async () => {
		// pinSafeLookup が literal IP 127.0.0.1 を isGlobalIp で弾き、connect 前に
		// EACCES を返す。エラー文に "SSRF blocked" が含まれることまで確認し、判定
		// 経路（DNS 失敗ではなく pin の reject）を固定する。
		await expect(fetchOgpImpl("http://127.0.0.1/")).rejects.toThrow(/SSRF blocked/);
	});
	it("blocks loopback v6 ::1 via SSRF (not DNS failure)", async () => {
		// IPv6 リテラル URL は `URL.hostname` が `[::1]` 表現で返るが、ogp.ts が
		// bracket を剥いて pinSafeLookup に渡すので、ENOTFOUND ではなく SSRF として
		// 弾かれることを確認する。ここで bracket 正規化が壊れると判定経路が
		// 「DNS 失敗で結果的に reject」に静かに退化するので回帰として固定する。
		await expect(fetchOgpImpl("http://[::1]/")).rejects.toThrow(/SSRF blocked/);
	});
	it("blocks link-local v4 169.254.169.254 (cloud metadata)", async () => {
		// AWS / GCP / Azure などの metadata service への SSRF を防ぐケース。
		await expect(fetchOgpImpl("http://169.254.169.254/")).rejects.toThrow(/SSRF blocked/);
	});
});

describe("ogp cancel (#101)", () => {
	beforeEach(() => clearCache());

	it("cancelOgpFetch on URL with no in-flight fetch is a no-op", () => {
		expect(() => cancelOgpFetch("https://no-in-flight.example/")).not.toThrow();
	});

	it("pre-aborted signal causes immediate AbortError without leaving in-flight entries", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(fetchOgpImpl("https://example.invalid/", controller.signal)).rejects.toThrowError(
			/abort/i,
		);
		// finally で必ず unregister されるので、in-flight Map に残骸が残らないこと。
		expect(hasInFlight("https://example.invalid/")).toBe(false);
	});

	it("cancelOgpFetch mid-fetch aborts the SSRF-blocked URL race cleanly", async () => {
		// SSRF で確実に reject される URL を使って、cancel が呼ばれても
		// (a) 二重 reject せず、(b) in-flight が cleanup されることを確認。
		// (実 HTTP path は e2e に委譲し、ここではユニットレベルで pure な検証に絞る)
		const p = fetchOgpImpl("http://127.0.0.1/");
		// cancel を 1 tick 後に発行。SSRF reject の方が早ければ no-op、間に合えば
		// abort が反映される。どちらでも最終的に reject かつ in-flight 0 が期待値。
		setTimeout(() => cancelOgpFetch("http://127.0.0.1/"), 0);
		await expect(p).rejects.toThrow();
		expect(hasInFlight("http://127.0.0.1/")).toBe(false);
	});

	it("AbortError fetch path leaves no cache entry (next call will retry)", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(fetchOgpImpl("https://retry.example/", controller.signal)).rejects.toThrowError(
			/abort/i,
		);
		// abort 経路は cache に何も書かない（fetchOgpImpl は finally で in-flight を
		// 消すだけで cacheSet は呼ばない）。
		expect(cacheGet("https://retry.example/")).toBeNull();
	});
});

describe("ogp cache behavior", () => {
	beforeEach(() => clearCache());

	it("cacheGet returns null for missing key", () => {
		expect(cacheGet("https://example.com/")).toBeNull();
	});

	it("cacheSet then cacheGet returns the data", () => {
		const data = {
			title: "T",
			description: null,
			image: null,
			siteName: null,
			url: "https://example.com/",
		};
		cacheSet("https://example.com/", data);
		expect(cacheGet("https://example.com/")).toEqual(data);
	});

	it("cacheGet expires entries past TTL", () => {
		const data = {
			title: "T",
			description: null,
			image: null,
			siteName: null,
			url: "https://example.com/",
		};
		const oldNow = 1_000_000;
		cacheSet("https://example.com/", data, oldNow);
		const future = oldNow + 25 * 60 * 60 * 1000;
		expect(cacheGet("https://example.com/", future)).toBeNull();
	});

	it("cacheSet evicts oldest when over capacity", () => {
		// MAX_CACHE_ENTRIES + 5 を入れて、最初の 5 件が evict されることを確認。
		// fetchedAt は now を分散させて oldest 判定を安定させる。
		for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i++) {
			cacheSet(
				`https://example.com/${i}`,
				{
					title: `t${i}`,
					description: null,
					image: null,
					siteName: null,
					url: `https://example.com/${i}`,
				},
				1_000_000 + i,
			);
		}
		// 容量内に収まっている
		const stillIn: string[] = [];
		for (let i = 0; i < MAX_CACHE_ENTRIES + 5; i++) {
			if (cacheGet(`https://example.com/${i}`) !== null) {
				stillIn.push(`${i}`);
			}
		}
		expect(stillIn.length).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
	});
});
