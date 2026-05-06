// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isGlobalIp } from "./ssrf-guard";

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
