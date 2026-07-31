// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildCsp, resolveDevOrigin, shouldBlockImageRequest } from "./remote-image-policy";

// 設定追加前に prod / dev で実際に送っていた CSP 文字列。ON 時の出力がこれと
// 完全一致することを pin して、関数化による regression を封じる。
const CSP_PROD_BEFORE =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' https: data: blob: scripta-asset:; font-src 'self' data:; " +
	"connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'";

const CSP_DEV_BEFORE =
	"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' https: data: blob: scripta-asset:; font-src 'self' data:; " +
	"connect-src 'self' ws://localhost:* http://localhost:*; worker-src 'self' blob:; " +
	"object-src 'none'; base-uri 'self'";

describe("buildCsp", () => {
	it("reproduces the pre-setting CSP exactly when remote images are allowed", () => {
		expect(buildCsp(false, true)).toBe(CSP_PROD_BEFORE);
		expect(buildCsp(true, true)).toBe(CSP_DEV_BEFORE);
	});

	it("drops only https: from img-src when remote images are disallowed", () => {
		expect(buildCsp(false, false)).toBe(
			CSP_PROD_BEFORE.replace("img-src 'self' https: ", "img-src 'self' "),
		);
		expect(buildCsp(true, false)).toBe(
			CSP_DEV_BEFORE.replace("img-src 'self' https: ", "img-src 'self' "),
		);
	});

	it("keeps local image sources usable while remote images are disallowed", () => {
		// OFF にしてもローカル画像 (scripta-asset:) / mermaid 等の生成物 (blob:, data:)
		// は表示され続けなければならない。ここが落ちるとオフライン用途まで壊れる。
		const csp = buildCsp(false, false);
		const imgSrc = csp.split("; ").find((d) => d.startsWith("img-src "));
		expect(imgSrc).toBe("img-src 'self' data: blob: scripta-asset:");
	});

	it("never allows file: in img-src (ADR-0002)", () => {
		for (const isDev of [true, false]) {
			for (const allow of [true, false]) {
				const imgSrc = buildCsp(isDev, allow)
					.split("; ")
					.find((d) => d.startsWith("img-src "));
				expect(imgSrc).not.toContain("file:");
			}
		}
	});

	it("differs between dev and prod only in script-src and connect-src", () => {
		const prod = buildCsp(false, true).split("; ");
		const dev = buildCsp(true, true).split("; ");
		const changed = prod.filter((d, i) => d !== dev[i]).map((d) => d.split(" ")[0]);
		expect(changed).toEqual(["script-src", "connect-src"]);
	});
});

describe("shouldBlockImageRequest", () => {
	it("blocks nothing while remote images are allowed", () => {
		expect(shouldBlockImageRequest("https://example.com/a.png", "image", true, null)).toBe(false);
	});

	it("blocks remote images when disallowed", () => {
		expect(shouldBlockImageRequest("https://example.com/a.png", "image", false, null)).toBe(true);
		expect(shouldBlockImageRequest("http://example.com/a.png", "image", false, null)).toBe(true);
	});

	it("blocks only image requests, not other resource types", () => {
		// script / stylesheet / xhr は本設定の管轄外 (CSP の default-src / connect-src
		// 'self' が既に閉じている)。ここで巻き込むと将来の機能を静かに壊す。
		for (const type of ["script", "stylesheet", "xhr", "font", "subFrame"]) {
			expect(shouldBlockImageRequest("https://example.com/a.png", type, false, null)).toBe(false);
		}
	});

	it("exempts the dev server origin so bundled assets keep loading", () => {
		const devOrigin = "http://localhost:5173";
		expect(
			shouldBlockImageRequest("http://localhost:5173/icon.png", "image", false, devOrigin),
		).toBe(false);
		// 別 origin は dev でも遮断される (port 違い / 別ホストを取りこぼさない)
		expect(
			shouldBlockImageRequest("http://localhost:9999/icon.png", "image", false, devOrigin),
		).toBe(true);
		expect(shouldBlockImageRequest("https://example.com/a.png", "image", false, devOrigin)).toBe(
			true,
		);
	});

	it("leaves non-http(s) schemes alone", () => {
		// urls フィルタで元々届かないが、関数単体としても巻き込まないことを pin する。
		expect(shouldBlockImageRequest("scripta-asset://localhost/w/a.png", "image", false, null)).toBe(
			false,
		);
		expect(shouldBlockImageRequest("data:image/png;base64,iVBORw0K", "image", false, null)).toBe(
			false,
		);
		expect(shouldBlockImageRequest("blob:file:///abc", "image", false, null)).toBe(false);
	});

	it("passes unparsable URLs through", () => {
		expect(shouldBlockImageRequest("not-a-url", "image", false, null)).toBe(false);
	});
});

describe("resolveDevOrigin", () => {
	it("extracts the origin from ELECTRON_RENDERER_URL", () => {
		expect(resolveDevOrigin("http://localhost:5173/")).toBe("http://localhost:5173");
		expect(resolveDevOrigin("http://localhost:5173/index.html")).toBe("http://localhost:5173");
	});

	it("returns null when unset or unparsable (prod: renderer is file:)", () => {
		expect(resolveDevOrigin(undefined)).toBe(null);
		expect(resolveDevOrigin("")).toBe(null);
		expect(resolveDevOrigin("not-a-url")).toBe(null);
	});
});
