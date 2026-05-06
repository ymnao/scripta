// @vitest-environment node
import { describe, expect, it } from "vitest";
import { compareSemver, parseSemver, stripVPrefix } from "./semver-lite";

describe("stripVPrefix", () => {
	it("strips lowercase v", () => {
		expect(stripVPrefix("v1.2.3")).toBe("1.2.3");
	});
	it("strips uppercase V", () => {
		expect(stripVPrefix("V1.2.3")).toBe("1.2.3");
	});
	it("returns input unchanged when no prefix", () => {
		expect(stripVPrefix("1.2.3")).toBe("1.2.3");
		expect(stripVPrefix("0.1.0")).toBe("0.1.0");
	});
	it("handles empty string", () => {
		expect(stripVPrefix("")).toBe("");
	});
});

describe("parseSemver - valid", () => {
	it("parses simple x.y.z", () => {
		expect(parseSemver("1.2.3")).toEqual({
			major: 1,
			minor: 2,
			patch: 3,
			prerelease: [],
		});
	});
	it("parses zeros", () => {
		expect(parseSemver("0.0.0")).toEqual({
			major: 0,
			minor: 0,
			patch: 0,
			prerelease: [],
		});
	});
	it("parses prerelease", () => {
		expect(parseSemver("1.0.0-beta.1").prerelease).toEqual(["beta", "1"]);
	});
	it("ignores build metadata", () => {
		expect(parseSemver("1.0.0+build.42").prerelease).toEqual([]);
		expect(parseSemver("1.0.0-rc.1+abc").prerelease).toEqual(["rc", "1"]);
	});
});

describe("parseSemver - invalid", () => {
	it("rejects non-numeric major", () => {
		expect(() => parseSemver("a.0.0")).toThrow(/Invalid version/);
	});
	it("rejects missing patch", () => {
		expect(() => parseSemver("1.2")).toThrow(/Invalid version/);
	});
	it("rejects extra dots", () => {
		expect(() => parseSemver("1.2.3.4")).toThrow(/Invalid version/);
	});
	it("rejects empty input", () => {
		expect(() => parseSemver("")).toThrow(/Invalid version/);
	});
	it("rejects garbage", () => {
		expect(() => parseSemver("not-a-version")).toThrow(/Invalid version/);
	});
	it("rejects empty prerelease identifier", () => {
		expect(() => parseSemver("1.0.0-")).toThrow(/Invalid version/);
		expect(() => parseSemver("1.0.0-beta..1")).toThrow(/Invalid version/);
	});
	it("rejects leading-zero numeric prerelease", () => {
		expect(() => parseSemver("1.0.0-01")).toThrow(/Invalid version/);
	});
	it("allows '0' as numeric prerelease", () => {
		expect(parseSemver("1.0.0-0").prerelease).toEqual(["0"]);
	});
});

describe("compareSemver", () => {
	const v = (s: string) => parseSemver(s);
	it("equal versions return 0", () => {
		expect(compareSemver(v("1.2.3"), v("1.2.3"))).toBe(0);
	});
	it("orders by major, minor, patch", () => {
		expect(compareSemver(v("2.0.0"), v("1.0.0"))).toBeGreaterThan(0);
		expect(compareSemver(v("1.1.0"), v("1.0.99"))).toBeGreaterThan(0);
		expect(compareSemver(v("1.0.5"), v("1.0.10"))).toBeLessThan(0);
	});
	it("release > prerelease (per SemVer §11)", () => {
		expect(compareSemver(v("1.0.0"), v("1.0.0-beta.1"))).toBeGreaterThan(0);
		expect(compareSemver(v("1.0.0-rc.1"), v("1.0.0"))).toBeLessThan(0);
	});
	it("compares prerelease identifiers in order", () => {
		expect(compareSemver(v("1.0.0-beta.1"), v("1.0.0-beta.2"))).toBeLessThan(0);
		expect(compareSemver(v("1.0.0-alpha"), v("1.0.0-beta"))).toBeLessThan(0);
	});
	it("numeric < alpha among prerelease ids (per SemVer §11)", () => {
		expect(compareSemver(v("1.0.0-1"), v("1.0.0-alpha"))).toBeLessThan(0);
	});
	it("more identifiers > fewer when prefix equal (per SemVer §11)", () => {
		expect(compareSemver(v("1.0.0-alpha"), v("1.0.0-alpha.1"))).toBeLessThan(0);
	});
});
