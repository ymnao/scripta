// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// `dns.promises.lookup` を最小モック化する。pinSafeLookup の hostname 経路だけが
// この mock に依存し、`isGlobalIp` 系の純粋関数テストは何も呼ばないので影響しない。
vi.mock("node:dns", async () => {
	const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
	return {
		...actual,
		promises: {
			...actual.promises,
			lookup: vi.fn(),
		},
	};
});

import { promises as dnsPromises } from "node:dns";
import { isGlobalIp, type PinnedLookup, pinSafeLookup } from "./ssrf-guard";

const mockedLookup = vi.mocked(dnsPromises.lookup);

// テストでは dns.lookup を mock するか literal IP 経路を通るため、現実的な
// タイムアウト発火は起きない。ただし pinSafeLookup は timeoutMs を必須引数と
// するので、共通の sentinel として 5s を渡す。
const T = 5_000;

describe("isGlobalIp - IPv4 non-global", () => {
	it("rejects loopback", () => {
		expect(isGlobalIp("127.0.0.1")).toBe(false);
	});
	it("rejects 0/8 entire range", () => {
		expect(isGlobalIp("0.0.0.0")).toBe(false);
		expect(isGlobalIp("0.1.2.3")).toBe(false);
		expect(isGlobalIp("0.255.255.255")).toBe(false);
	});
	it("rejects RFC 1918 private", () => {
		expect(isGlobalIp("10.0.0.1")).toBe(false);
		expect(isGlobalIp("172.16.0.1")).toBe(false);
		expect(isGlobalIp("172.31.255.255")).toBe(false);
		expect(isGlobalIp("192.168.1.1")).toBe(false);
	});
	it("rejects link-local", () => {
		expect(isGlobalIp("169.254.1.1")).toBe(false);
	});
	it("rejects CGNAT (100.64/10)", () => {
		expect(isGlobalIp("100.64.0.1")).toBe(false);
		expect(isGlobalIp("100.127.255.254")).toBe(false);
	});
	it("rejects documentation ranges", () => {
		expect(isGlobalIp("192.0.2.1")).toBe(false);
		expect(isGlobalIp("198.51.100.1")).toBe(false);
		expect(isGlobalIp("203.0.113.1")).toBe(false);
	});
	it("rejects benchmarking range (198.18/15)", () => {
		expect(isGlobalIp("198.18.0.1")).toBe(false);
		expect(isGlobalIp("198.19.255.1")).toBe(false);
	});
	it("rejects 192.0.0/24 (IETF)", () => {
		expect(isGlobalIp("192.0.0.1")).toBe(false);
	});
	it("rejects multicast (224/4)", () => {
		expect(isGlobalIp("224.0.0.1")).toBe(false);
		expect(isGlobalIp("239.255.255.255")).toBe(false);
	});
	it("rejects reserved (240/4)", () => {
		expect(isGlobalIp("240.0.0.1")).toBe(false);
		expect(isGlobalIp("255.255.255.255")).toBe(false);
	});
});

describe("isGlobalIp - IPv4 global", () => {
	it("allows public DNS", () => {
		expect(isGlobalIp("8.8.8.8")).toBe(true);
		expect(isGlobalIp("1.1.1.1")).toBe(true);
	});
	it("allows 100.63.x.x (just outside CGNAT range)", () => {
		expect(isGlobalIp("100.63.255.255")).toBe(true);
	});
	it("allows 172.32.0.0 (just outside 172.16/12 private)", () => {
		expect(isGlobalIp("172.32.0.1")).toBe(true);
	});
	it("allows known public host", () => {
		expect(isGlobalIp("93.184.216.34")).toBe(true);
	});
});

describe("isGlobalIp - IPv6 non-global", () => {
	it("rejects loopback ::1", () => {
		expect(isGlobalIp("::1")).toBe(false);
	});
	it("rejects unspecified ::", () => {
		expect(isGlobalIp("::")).toBe(false);
	});
	it("rejects ULA (fc00::/7)", () => {
		expect(isGlobalIp("fc00::1")).toBe(false);
		expect(isGlobalIp("fd00::1")).toBe(false);
	});
	it("rejects link-local (fe80::/10)", () => {
		expect(isGlobalIp("fe80::1")).toBe(false);
	});
	it("rejects link-local with zone id", () => {
		expect(isGlobalIp("fe80::1%eth0")).toBe(false);
	});
	it("rejects documentation 2001:db8::/32", () => {
		expect(isGlobalIp("2001:db8::1")).toBe(false);
	});
	it("rejects IETF 2001::/23", () => {
		expect(isGlobalIp("2001::1")).toBe(false);
		expect(isGlobalIp("2001:1ff::1")).toBe(false);
	});
	it("rejects 6to4 2002::/16", () => {
		expect(isGlobalIp("2002::1")).toBe(false);
	});
});

describe("isGlobalIp - IPv6 global", () => {
	it("allows global unicast 2001:4860::", () => {
		expect(isGlobalIp("2001:4860:4860::8888")).toBe(true);
	});
	it("allows Cloudflare 2606:4700::", () => {
		expect(isGlobalIp("2606:4700:4700::1111")).toBe(true);
	});
});

describe("isGlobalIp - invalid input", () => {
	it("rejects garbage strings", () => {
		expect(isGlobalIp("not-an-ip")).toBe(false);
		expect(isGlobalIp("")).toBe(false);
		expect(isGlobalIp("999.999.999.999")).toBe(false);
		expect(isGlobalIp("1.2.3")).toBe(false);
	});
	it("rejects 256+ octets", () => {
		expect(isGlobalIp("256.0.0.0")).toBe(false);
	});
	it("rejects malformed v6", () => {
		expect(isGlobalIp("2001::db8::1")).toBe(false);
		expect(isGlobalIp("xyz::1")).toBe(false);
	});
});

describe("pinSafeLookup - literal IP fast-path (no DNS lookup)", () => {
	beforeEach(() => {
		mockedLookup.mockReset();
	});
	it("pins literal IPv4 without invoking dns.lookup", async () => {
		const pin = await pinSafeLookup("8.8.8.8", T);
		expect(pin.address).toBe("8.8.8.8");
		expect(pin.family).toBe(4);
		expect(mockedLookup).not.toHaveBeenCalled();
	});
	it("pins literal IPv6 without invoking dns.lookup", async () => {
		const pin = await pinSafeLookup("2001:4860:4860::8888", T);
		expect(pin.address).toBe("2001:4860:4860::8888");
		expect(pin.family).toBe(6);
		expect(mockedLookup).not.toHaveBeenCalled();
	});
	it("rejects literal private IPv4 with SSRF error", async () => {
		await expect(pinSafeLookup("127.0.0.1", T)).rejects.toThrow(/SSRF blocked/);
		await expect(pinSafeLookup("169.254.169.254", T)).rejects.toThrow(/SSRF blocked/);
		await expect(pinSafeLookup("10.0.0.1", T)).rejects.toThrow(/SSRF blocked/);
	});
	it("rejects literal private IPv6 with SSRF error", async () => {
		await expect(pinSafeLookup("::1", T)).rejects.toThrow(/SSRF blocked/);
		await expect(pinSafeLookup("fe80::1", T)).rejects.toThrow(/SSRF blocked/);
	});
});

describe("pinSafeLookup - hostname resolution", () => {
	beforeEach(() => {
		mockedLookup.mockReset();
	});
	it("resolves hostname via dns.lookup and pins the result", async () => {
		mockedLookup.mockResolvedValueOnce({ address: "93.184.216.34", family: 4 });
		const pin = await pinSafeLookup("example.com", T);
		expect(pin.address).toBe("93.184.216.34");
		expect(pin.family).toBe(4);
		expect(mockedLookup).toHaveBeenCalledTimes(1);
	});
	it("rejects when dns.lookup returns private IP", async () => {
		// 攻撃者の DNS が初回から private IP を返してきても、pin 作成段階で
		// isGlobalIp によって弾かれる。
		mockedLookup.mockResolvedValueOnce({ address: "169.254.169.254", family: 4 });
		await expect(pinSafeLookup("malicious.example", T)).rejects.toThrow(/SSRF blocked/);
	});
	it("propagates dns.lookup ENOTFOUND as DNS error (not SSRF)", async () => {
		const err = new Error("getaddrinfo ENOTFOUND") as NodeJS.ErrnoException;
		err.code = "ENOTFOUND";
		mockedLookup.mockRejectedValueOnce(err);
		await expect(pinSafeLookup("nonexistent.invalid", T)).rejects.toThrow(/ENOTFOUND/);
	});
	it("rejects with ETIMEDOUT when dns.lookup exceeds timeout", async () => {
		// dns.lookup を「永遠に resolve しない」mock にする。Promise.race の
		// タイマー側が先に発火することを確認。タイマーは小さい値（30ms）にして
		// テストの実時間を抑える。
		mockedLookup.mockImplementation(() => new Promise(() => {}));
		await expect(pinSafeLookup("slow.example", 30)).rejects.toThrow(/timeout/i);
	});
});

describe("pinSafeLookup - DNS rebinding defense", () => {
	beforeEach(() => {
		mockedLookup.mockReset();
	});
	it("dns.lookup is invoked exactly once per pin (rebind on later calls is irrelevant)", async () => {
		// 攻撃シナリオ: 攻撃者の DNS が 1 回目に public IP、2 回目以降に private IP を
		// 返す。pinSafeLookup は 1 度しか dns.lookup を呼ばないので、後続の rebind は
		// connect 経路に到達しない。後続の mockResolvedValue は「もし 2 回目が起きたら
		// rebind が成立してしまう」シナリオを再現するための仕掛け。
		mockedLookup
			.mockResolvedValueOnce({ address: "93.184.216.34", family: 4 })
			.mockResolvedValue({ address: "169.254.169.254", family: 4 });
		const pin = await pinSafeLookup("rebind.example", T);
		expect(pin.address).toBe("93.184.216.34");
		// pin の lookup フックを何度呼んでも dns.lookup は再発火しない
		for (let i = 0; i < 3; i++) {
			const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
				pin.lookup("rebind.example", { all: false }, (err, address, family) => {
					if (err) reject(err);
					else resolve({ address, family });
				});
			});
			expect(result.address).toBe("93.184.216.34");
			expect(result.family).toBe(4);
		}
		expect(mockedLookup).toHaveBeenCalledTimes(1);
	});
	it("pinned lookup honors all:true option without re-querying DNS", async () => {
		mockedLookup.mockResolvedValueOnce({ address: "93.184.216.34", family: 4 });
		const pin = await pinSafeLookup("rebind.example", T);
		const addresses = await new Promise<Array<{ address: string; family: number }>>(
			(resolve, reject) => {
				// SafeLookup の callback union は options で narrow されないため、
				// all:true 経路で渡される LookupAllCallback としてキャストする。
				pin.lookup("rebind.example", { all: true }, ((
					err: NodeJS.ErrnoException | null,
					addrs: Array<{ address: string; family: number }>,
				) => {
					if (err) reject(err);
					else resolve(addrs);
				}) as Parameters<typeof pin.lookup>[2]);
			},
		);
		expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
		expect(mockedLookup).toHaveBeenCalledTimes(1);
	});
	it("pinned lookup returns the saved IP regardless of hostname argument", async () => {
		// Node の HTTP keep-alive や redirect 等で異なる hostname で呼ばれても、
		// 同じ pin を使う限りは保存済み IP に固定される（hostname 引数は無視）。
		mockedLookup.mockResolvedValueOnce({ address: "93.184.216.34", family: 4 });
		const pin = await pinSafeLookup("rebind.example", T);
		const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
			pin.lookup("totally-different-host.example", { all: false }, (err, address, family) => {
				if (err) reject(err);
				else resolve({ address, family });
			});
		});
		expect(result.address).toBe("93.184.216.34");
		expect(mockedLookup).toHaveBeenCalledTimes(1);
	});
});

describe("pinSafeLookup - family option contract", () => {
	beforeEach(() => {
		mockedLookup.mockReset();
	});
	// pin の lookup フックを Promise でラップして single 経路で呼び出すヘルパ。
	function callSingle(
		pin: PinnedLookup,
		family?: number,
	): Promise<{ address: string; family: number }> {
		return new Promise((resolve, reject) => {
			const opts = family === undefined ? {} : { family };
			pin.lookup("any.example", opts, ((
				err: NodeJS.ErrnoException | null,
				address: string,
				fam: number,
			) => {
				if (err) reject(err);
				else resolve({ address, family: fam });
			}) as Parameters<typeof pin.lookup>[2]);
		});
	}
	it("accepts family: 0 (any) on IPv4 pin", async () => {
		const pin = await pinSafeLookup("8.8.8.8", T);
		await expect(callSingle(pin, 0)).resolves.toEqual({ address: "8.8.8.8", family: 4 });
	});
	it("accepts undefined family on IPv6 pin", async () => {
		const pin = await pinSafeLookup("2001:4860:4860::8888", T);
		await expect(callSingle(pin)).resolves.toEqual({
			address: "2001:4860:4860::8888",
			family: 6,
		});
	});
	it("accepts matching family", async () => {
		const pinV4 = await pinSafeLookup("8.8.8.8", T);
		await expect(callSingle(pinV4, 4)).resolves.toEqual({ address: "8.8.8.8", family: 4 });
		const pinV6 = await pinSafeLookup("2001:4860:4860::8888", T);
		await expect(callSingle(pinV6, 6)).resolves.toEqual({
			address: "2001:4860:4860::8888",
			family: 6,
		});
	});
	it("rejects family mismatch (IPv6 requested for IPv4 pin)", async () => {
		const pin = await pinSafeLookup("8.8.8.8", T);
		await expect(callSingle(pin, 6)).rejects.toThrow(/family mismatch/);
	});
	it("rejects family mismatch (IPv4 requested for IPv6 pin)", async () => {
		const pin = await pinSafeLookup("2001:4860:4860::8888", T);
		await expect(callSingle(pin, 4)).rejects.toThrow(/family mismatch/);
	});
});
