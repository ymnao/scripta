import type { IncomingMessage, RequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { SafeLookup } from "./ssrf-guard";

// `https.request` を Promise でラップして、(a) timeout / (b) max body bytes /
// (c) SSRF-safe lookup を 1 箇所に集約するヘルパ。
//
// 同等の boilerplate を ipc/ogp.ts と ipc/update.ts で 2 箇所に書いていたが、
// settled flag / chunk 累積 / close vs end の取り扱い / req.on("timeout") などの
// 微妙な分岐が divergence の温床になるため共通化する。
//
// 「max body 超過時の挙動」だけは呼び出し側で意味が違う:
//  - OGP fetch: 100KB を超える HTML は **先頭 100KB に truncate** して parser へ。
//    OGP メタは <head> 内なので前方バイト列のみで十分。
//  - GitHub release fetch: 100KB を超える応答は **異常** とみなし reject。
// この差異は `onMaxExceeded` で切り替える。

export interface HttpFetchResult {
	statusCode: number;
	headers: IncomingMessage["headers"];
	body: Buffer;
	truncated: boolean;
}

export interface HttpFetchOptions {
	url: URL;
	method?: string;
	headers?: Record<string, string>;
	timeoutMs: number;
	maxBodyBytes: number;
	// "truncate": maxBodyBytes に達した時点で `body` を切り詰めて success
	//             (`truncated: true` を立てて返す)
	// "reject":   maxBodyBytes 超過時は Error で reject（応答自体を異常扱い）
	onMaxExceeded: "truncate" | "reject";
	// 接続時 lookup で SSRF を防ぐ。任意のホスト相手の fetch では指定し、信頼済み
	// エンドポイント（GitHub API 等）相手では省略してシステム DNS を使う。
	lookup?: SafeLookup;
}

export function httpFetch(opts: HttpFetchOptions): Promise<HttpFetchResult> {
	const { url, timeoutMs, maxBodyBytes, onMaxExceeded } = opts;
	return new Promise((resolve, reject) => {
		const isHttps = url.protocol === "https:";
		const requester = isHttps ? httpsRequest : httpRequest;
		// `URL.port` は string 型（未指定なら ""）。Node `RequestOptions.port` は
		// `number | string` を許容するが overload 解決の都合で any 化が必要なため、
		// 明示的に number 化して曖昧さを排除する。
		const port = url.port.length > 0 ? Number(url.port) : isHttps ? 443 : 80;
		const reqOpts: RequestOptions = {
			protocol: url.protocol,
			hostname: url.hostname,
			port,
			path: `${url.pathname || "/"}${url.search}`,
			method: opts.method ?? "GET",
			headers: opts.headers,
			timeout: timeoutMs,
		};
		// Node の http(s) は lookup undefined を渡すと system default になるが、
		// 「指定しないと system default」と「明示 undefined」を区別せずに済むよう
		// 値があるときのみ追加する。
		if (opts.lookup !== undefined) {
			(reqOpts as { lookup?: SafeLookup }).lookup = opts.lookup;
		}
		const req = requester(reqOpts, (res) => {
			const chunks: Buffer[] = [];
			let total = 0;
			let truncated = false;
			let settled = false;
			res.on("data", (chunk: Buffer) => {
				if (settled || truncated) return;
				const remaining = maxBodyBytes - total;
				if (chunk.length <= remaining) {
					chunks.push(chunk);
					total += chunk.length;
					return;
				}
				if (onMaxExceeded === "reject") {
					settled = true;
					res.destroy();
					reject(new Error("Response body exceeds maxBodyBytes"));
					return;
				}
				if (remaining > 0) {
					chunks.push(chunk.subarray(0, remaining));
					total += remaining;
				}
				truncated = true;
				res.destroy();
			});
			res.on("end", () => {
				if (settled) return;
				settled = true;
				resolve({
					statusCode: res.statusCode ?? 0,
					headers: res.headers,
					body: Buffer.concat(chunks),
					truncated,
				});
			});
			res.on("close", () => {
				if (settled) return;
				settled = true;
				// `end` を経由せずに close した場合は 2 種に分岐する:
				//   (a) maxBodyBytes 超過で我々が destroy したケース → 部分 body を
				//       「正常に切り詰めた結果」として resolve（truncate モード時のみ）。
				//   (b) サーバ切断 / ネットワーク瞬断 / 早期 EOF → 部分 body は
				//       不完全なので reject。
				if (truncated) {
					resolve({
						statusCode: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks),
						truncated,
					});
				} else {
					reject(new Error("Connection closed before response ended"));
				}
			});
			res.on("error", (e) => {
				if (settled) return;
				settled = true;
				reject(e);
			});
		});
		req.on("timeout", () => {
			req.destroy(new Error("Request timeout"));
		});
		req.on("error", reject);
		req.end();
	});
}
