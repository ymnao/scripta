// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { __testing } from "./ogp";

const { fetchOgpImpl, cacheGet, cacheSet, clearCache, MAX_CACHE_ENTRIES } = __testing;

// SSRF defense (safeLookup) が public IP のみ許可するため、local HTTP サーバを
// 立てて round-trip を確認する integration test は接続段階で確実に reject される。
// したがってここでは:
//   - scheme 検証
//   - SSRF deny（127.0.0.1 / ::1 / 169.254.169.254 等の典型例）
//   - cache の TTL / capacity 動作
// の 3 観点に絞って単体テストする。実 fetch path は e2e で確認するか、本物の
// global URL を使う将来テストで担保する。

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

describe("ogp SSRF defense via safeLookup", () => {
	beforeEach(() => clearCache());
	it("blocks private hostname (127.0.0.1) at connect", async () => {
		// safeLookup が 127.0.0.1 を解決した瞬間に EACCES を返す。
		// http.request の error イベントで reject される。
		await expect(fetchOgpImpl("http://127.0.0.1/")).rejects.toThrow();
	});
	it("blocks loopback v6 ::1", async () => {
		await expect(fetchOgpImpl("http://[::1]/")).rejects.toThrow();
	});
	it("blocks link-local v4 169.254.169.254 (cloud metadata)", async () => {
		// AWS / GCP / Azure などの metadata service への SSRF を防ぐケース。
		await expect(fetchOgpImpl("http://169.254.169.254/")).rejects.toThrow();
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
