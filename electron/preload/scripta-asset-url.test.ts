import { describe, expect, it } from "vitest";
import { buildScriptaAssetUrl, urlPathnameToFsPath } from "./scripta-asset-url";

describe("buildScriptaAssetUrl", () => {
	it("Unix 絶対パスを valid な URL にする", () => {
		const url = buildScriptaAssetUrl("/Users/foo/img.png");
		expect(url).toBe("scripta-asset://localhost/Users/foo/img.png");
		const parsed = new URL(url);
		expect(parsed.hostname).toBe("localhost");
		expect(parsed.pathname).toBe("/Users/foo/img.png");
	});

	it("Windows backslash 形式は forward slash に正規化し leading / を付与する", () => {
		const url = buildScriptaAssetUrl("C:\\Users\\img.png");
		// `:` は per-segment encodeURIComponent で `%3A` にエンコードされる
		expect(url).toBe("scripta-asset://localhost/C%3A/Users/img.png");
		const parsed = new URL(url);
		// 旧実装 `scripta-asset://localhostC:\\Users\\img.png` は `Invalid URL` でパース不能。
		// hostname が localhost であることが保証されないと protocol handler 側の hostname
		// チェックを通過できないので、ここで明示的に固定する。
		expect(parsed.hostname).toBe("localhost");
	});

	it("Windows forward slash 形式も同じ URL を生成する", () => {
		expect(buildScriptaAssetUrl("C:/Users/img.png")).toBe(
			"scripta-asset://localhost/C%3A/Users/img.png",
		);
	});

	it("# / ? を含むパスは encode され pathname/hash/search に分断されない", () => {
		const url = buildScriptaAssetUrl("/tmp/a#b?c.png");
		expect(url).toBe("scripta-asset://localhost/tmp/a%23b%3Fc.png");
		const parsed = new URL(url);
		expect(parsed.pathname).toBe("/tmp/a%23b%3Fc.png");
		// 旧実装 `scripta-asset://localhost/tmp/a#b?c.png` は pathname=/tmp/a, hash=#b?c.png
		// に分断されていた。encode により分断されないことを確認する。
		expect(parsed.hash).toBe("");
		expect(parsed.search).toBe("");
	});

	it("空白・日本語を含むパスを encode する", () => {
		const url = buildScriptaAssetUrl("/Users/foo bar/日本語.png");
		const parsed = new URL(url);
		expect(parsed.hostname).toBe("localhost");
		expect(decodeURIComponent(parsed.pathname)).toBe("/Users/foo bar/日本語.png");
	});

	it("％を含むパスを正しく encode する（dec → enc → dec の round-trip）", () => {
		// `%2F` のような既存の percent-sequence をそのまま渡したいケースで `encodeURI` だと
		// 二重 encode 漏れが起きうる。per-segment `encodeURIComponent` で `%` → `%25` になる
		// ことを確認する。
		const original = "/tmp/100%done.png";
		const url = buildScriptaAssetUrl(original);
		const parsed = new URL(url);
		expect(decodeURIComponent(parsed.pathname)).toBe(original);
	});
});

describe("urlPathnameToFsPath", () => {
	it("Unix の pathname はそのまま返す", () => {
		expect(urlPathnameToFsPath("/Users/foo/img.png")).toBe("/Users/foo/img.png");
	});

	it("Windows drive letter 形式は leading / を除去する", () => {
		expect(urlPathnameToFsPath("/C:/Users/img.png")).toBe("C:/Users/img.png");
		expect(urlPathnameToFsPath("/c:/Users/img.png")).toBe("c:/Users/img.png");
	});

	it("percent-encoded sequence を decode する", () => {
		expect(urlPathnameToFsPath("/tmp/a%23b%3Fc.png")).toBe("/tmp/a#b?c.png");
		expect(urlPathnameToFsPath("/Users/foo%20bar/img.png")).toBe("/Users/foo bar/img.png");
	});

	it("buildScriptaAssetUrl との round-trip が原形に戻る", () => {
		const cases = [
			"/Users/foo/img.png",
			"/tmp/a#b.png",
			"/Users/foo bar/日本語.png",
			"/tmp/100%done.png",
		];
		for (const original of cases) {
			const built = buildScriptaAssetUrl(original);
			const parsed = new URL(built);
			const restored = urlPathnameToFsPath(parsed.pathname);
			expect(restored).toBe(original);
		}
	});

	it("Windows path の round-trip では `\\` → `/` 正規化を経由した値に戻る", () => {
		const built = buildScriptaAssetUrl("C:\\Users\\img.png");
		const parsed = new URL(built);
		const restored = urlPathnameToFsPath(parsed.pathname);
		// backslash は `/` 正規化済み
		expect(restored).toBe("C:/Users/img.png");
	});
});
