import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { ipcMain } from "electron";
import type { OgpData } from "../../../src/types/ogp";
import { parseOgp } from "../utils/ogp-parser";
import { safeLookup } from "../utils/ssrf-guard";

// 旧 Tauri 版 src-tauri/src/commands/ogp.rs `fetch_ogp` を Node stdlib に移植。
// SSRF 防御は `http(s).request({ lookup: safeLookup })` で接続時 IP を弾く方式で
// 担保する（utils/ssrf-guard.ts 参照）。ureq の `Resolver` カスタマイズと等価。

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MAX_BODY_BYTES = 100 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 5;

interface CacheEntry {
	data: OgpData;
	fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheGet(url: string, now: number = Date.now()): OgpData | null {
	const entry = cache.get(url);
	if (!entry) return null;
	if (now - entry.fetchedAt >= CACHE_TTL_MS) {
		cache.delete(url);
		return null;
	}
	return entry.data;
}

function cacheSet(url: string, data: OgpData, now: number = Date.now()): void {
	// 期限切れエントリを先に掃除する（旧 Rust と同方針）。
	for (const [k, v] of cache) {
		if (now - v.fetchedAt >= CACHE_TTL_MS) cache.delete(k);
	}
	// 容量超過時は fetched_at が最古のエントリを 1 件だけ evict。
	if (!cache.has(url) && cache.size >= MAX_CACHE_ENTRIES) {
		let oldestKey: string | null = null;
		let oldestTime = Number.POSITIVE_INFINITY;
		for (const [k, v] of cache) {
			if (v.fetchedAt < oldestTime) {
				oldestTime = v.fetchedAt;
				oldestKey = k;
			}
		}
		if (oldestKey !== null) cache.delete(oldestKey);
	}
	cache.set(url, { data, fetchedAt: now });
}

export function clearOgpCache(): void {
	cache.clear();
}

interface FetchResult {
	statusCode: number;
	headers: IncomingMessage["headers"];
	body: Buffer;
	truncated: boolean;
}

function fetchOnce(url: URL): Promise<FetchResult> {
	return new Promise((resolve, reject) => {
		const isHttps = url.protocol === "https:";
		const requester = isHttps ? httpsRequest : httpRequest;
		const req = requester(
			{
				protocol: url.protocol,
				hostname: url.hostname,
				port: url.port || (isHttps ? 443 : 80),
				path: `${url.pathname || "/"}${url.search}`,
				method: "GET",
				headers: {
					"User-Agent": "scripta",
					Accept: "text/html,application/xhtml+xml",
				},
				lookup: safeLookup,
				timeout: REQUEST_TIMEOUT_MS,
			},
			(res) => {
				const chunks: Buffer[] = [];
				let total = 0;
				let truncated = false;
				let settled = false;
				res.on("data", (chunk: Buffer) => {
					if (settled) return;
					if (truncated) return;
					const remaining = MAX_BODY_BYTES - total;
					if (chunk.length <= remaining) {
						chunks.push(chunk);
						total += chunk.length;
					} else {
						if (remaining > 0) {
							chunks.push(chunk.subarray(0, remaining));
							total += remaining;
						}
						truncated = true;
						res.destroy();
					}
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
					// truncated で destroy() を呼んだ場合はここに入る。
					resolve({
						statusCode: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks),
						truncated,
					});
				});
				res.on("error", (e) => {
					if (settled) return;
					settled = true;
					reject(e);
				});
			},
		);
		req.on("timeout", () => {
			req.destroy(new Error("Request timeout"));
		});
		req.on("error", reject);
		req.end();
	});
}

async function fetchWithRedirects(urlStr: string): Promise<{ contentType: string; body: Buffer }> {
	let current = urlStr;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const parsed = new URL(current);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("Only http and https URLs are supported");
		}
		const res = await fetchOnce(parsed);
		if (res.statusCode >= 300 && res.statusCode < 400) {
			const loc = res.headers.location;
			if (typeof loc === "string" && loc.length > 0) {
				if (hop >= MAX_REDIRECTS) {
					throw new Error("Too many redirects");
				}
				current = new URL(loc, parsed).toString();
				continue;
			}
		}
		if (res.statusCode < 200 || res.statusCode >= 300) {
			throw new Error(`HTTP ${res.statusCode}`);
		}
		const ctRaw = res.headers["content-type"];
		const contentType = typeof ctRaw === "string" ? ctRaw : "";
		return { contentType, body: res.body };
	}
	throw new Error("Too many redirects");
}

async function fetchOgpImpl(url: string): Promise<OgpData> {
	const lower = url.toLowerCase();
	if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
		throw new Error("Only http and https URLs are supported");
	}
	const cached = cacheGet(url);
	if (cached) return cached;

	const { contentType, body } = await fetchWithRedirects(url);
	if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
		throw new Error(`Unsupported content type: ${contentType}`);
	}
	const html = body.toString("utf8");
	const ogp = parseOgp(html, url);
	cacheSet(url, ogp);
	return ogp;
}

export function registerOgpIpc(): void {
	ipcMain.handle("ogp:fetch", (_event, url: string) => fetchOgpImpl(url));
}

export const __testing = {
	fetchOgpImpl,
	cacheGet,
	cacheSet,
	clearCache: clearOgpCache,
	CACHE_TTL_MS,
	MAX_CACHE_ENTRIES,
};
