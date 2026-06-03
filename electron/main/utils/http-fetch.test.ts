// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AbortError, httpFetch } from "./http-fetch";

// `httpFetch` の AbortSignal 経路を unit レベルで検証する。
// 真の mid-flight abort（実 socket connect 後の req.destroy）は SSRF guard 込みで
// `ogp.test.ts` 側がレース込みで担保する。ここでは:
//   - AbortError class が name="AbortError" であること
//   - pre-aborted signal で request を投げずに即時 reject すること
// に絞る。サンドボックス下で `server.listen` できないため、応答待ちサーバを
// 立てる経路は使えない（`pnpm verify` の e2e webServer も EPERM で稀に落ちる
// のと同じ理由）。

describe("AbortError", () => {
	it("has name = 'AbortError' for instance discrimination", () => {
		const err = new AbortError();
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("AbortError");
	});

	it("accepts a custom message", () => {
		const err = new AbortError("custom");
		expect(err.message).toBe("custom");
	});
});

describe("httpFetch abort", () => {
	it("rejects with AbortError when signal is pre-aborted (request is never sent)", async () => {
		const controller = new AbortController();
		controller.abort();
		// 接続不可能な URL を使っても、pre-aborted 短絡で `requester` は呼ばれない。
		await expect(
			httpFetch({
				url: new URL("http://192.0.2.1:1/"),
				timeoutMs: 5_000,
				maxBodyBytes: 1024,
				onMaxExceeded: "truncate",
				signal: controller.signal,
			}),
		).rejects.toBeInstanceOf(AbortError);
	});
});
