import { URL } from "node:url";
import { LruCache } from "../../../src/lib/lru-cache";
import type { OgpData } from "../../../src/types/ogp";
import { AbortError, httpFetch } from "../utils/http-fetch";
import { handle } from "../utils/ipc-handle";
import { parseOgp } from "../utils/ogp-parser";
import { pinSafeLookup, stripIpBrackets } from "../utils/ssrf-guard";
import { StructuredError } from "../utils/structured-error";

// OGP メタデータを取得する（`fetch_ogp`）。
// SSRF 防御は redirect 1 hop ごとに `pinSafeLookup` で hostname を 1 度だけ解決し、
// 解決済み IP を pin して http(s).request の `lookup` フックに渡す。これにより:
//   - DNS 名: 1 回の dns.lookup → isGlobalIp 検証 → 以後の connect は pin された IP
//     を使う（rebinding 攻撃が validation 後に DNS 応答を切替えても影響しない）
//   - literal IP: dns.lookup をスキップし isGlobalIp 直接判定で pin 生成
// HTTP 層の Promise / timeout / body-limit boilerplate は utils/http-fetch.ts へ集約。

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE = 500;
const MAX_BODY_BYTES = 100 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 5;

interface CacheEntry {
	data: OgpData;
	fetchedAt: number;
}

// TTL sweep は撤去し、freshness は cacheGet の read-time TTL check で担保する。
// cap 超過時は LruCache が O(1) で最も長く未参照 (LRU) の 1 件を evict する。
// cacheGet が hit ごとに LruCache.get で touch するため、頻繁に再描画される URL は
// 保持されやすく、放置された URL が優先的に押し出される。
const cache = new LruCache<string, CacheEntry>(MAX_CACHE_SIZE);

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
	cache.set(url, { data, fetchedAt: now });
}

export function clearOgpCache(): void {
	cache.clear();
}

// in-flight な fetch の cancel 用 controller を **request 単位**で保持する。
// renderer 側が unique requestId を生成して `ogp:fetch` に渡し、destroy 時には
// その requestId だけを `ogp:cancel` する。URL をキーにすると後勝ち上書きで他 view
// の後発 request を誤 abort してしまうため、requestId で個別に追跡する。
const inFlight = new Map<string, AbortController>();

export function cancelOgpFetch(requestId: string): void {
	inFlight.get(requestId)?.abort();
}

async function fetchWithRedirects(
	urlStr: string,
	signal: AbortSignal,
): Promise<{ contentType: string; body: Buffer }> {
	let current = urlStr;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		// hop 頭での abort 早期判定。pinSafeLookup / DNS 待ちは signal を受け取らない
		// ため、abort が反映されないと最大 REQUEST_TIMEOUT_MS まで in-flight が残る。
		// ここで弾くことで cancel の即時性を確保する（少なくとも次の hop に進まない）。
		if (signal.aborted) throw new AbortError();
		const parsed = new URL(current);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("Only http and https URLs are supported");
		}
		// hostname の DNS 解決と SSRF 検証を 1 回で済ませて IP を pin する。
		// hostname は IPv6 リテラルでは bracket 付きで返るので剥いてから渡す。
		// 1 hop の総 budget は REQUEST_TIMEOUT_MS（旧 safeLookup 経路の socket timeout
		// 同等）。DNS で消費した時間を差し引いた残りを HTTP timeout として渡し、
		// 「DNS + HTTP で 1 hop あたり最大 REQUEST_TIMEOUT_MS」を維持する。
		const bareHost = stripIpBrackets(parsed.hostname);
		const hopStart = Date.now();
		const pin = await pinSafeLookup(bareHost, REQUEST_TIMEOUT_MS, signal);
		const httpTimeout = Math.max(1, REQUEST_TIMEOUT_MS - (Date.now() - hopStart));
		const res = await httpFetch({
			url: parsed,
			headers: {
				"User-Agent": "scripta",
				Accept: "text/html,application/xhtml+xml",
			},
			timeoutMs: httpTimeout,
			maxBodyBytes: MAX_BODY_BYTES,
			onMaxExceeded: "truncate",
			lookup: pin.lookup,
			signal,
		});
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
		// Node の IncomingHttpHeaders は値が `string | string[] | undefined` を取る。
		// 正常な HTTP では `Content-Type` ヘッダは 1 つなので Node は通常 string に
		// 統合するが、複数返した実装では string[] になる。先頭要素を採用する。
		const ctRaw = res.headers["content-type"];
		const contentType =
			typeof ctRaw === "string" ? ctRaw : Array.isArray(ctRaw) ? (ctRaw[0] ?? "") : "";
		return { contentType, body: res.body };
	}
	throw new Error("Too many redirects");
}

async function fetchOgpImpl(requestId: string, url: string): Promise<OgpData> {
	const lower = url.toLowerCase();
	if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
		throw new Error("Only http and https URLs are supported");
	}
	const cached = cacheGet(url);
	if (cached) return cached;

	const controller = new AbortController();
	inFlight.set(requestId, controller);
	try {
		const { contentType, body } = await fetchWithRedirects(url, controller.signal);
		// RFC 7231 §3.1.1.1: media-type は case-insensitive（"Text/HTML" 等を許容）。
		const lowerCt = contentType.toLowerCase();
		if (!lowerCt.includes("text/html") && !lowerCt.includes("application/xhtml")) {
			throw new Error(`Unsupported content type: ${contentType}`);
		}
		const html = body.toString("utf8");
		const ogp = parseOgp(html, url);
		cacheSet(url, ogp);
		return ogp;
	} catch (err) {
		// IPC 越しに `err.name` は保たれないので、cancel 経路は ErrorKind="ABORTED" の
		// StructuredError に変換して renderer に渡す（renderer は getErrorKind で判別）。
		// AbortError は http-fetch 層からの socket abort、controller.signal.aborted
		// は DNS lookup 中の abort も捕捉する（pinSafeLookup が ABORT_ERR で reject した
		// 場合の err はカスタム Error なので signal 判定で拾う）。
		if (err instanceof AbortError || controller.signal.aborted) {
			throw new StructuredError("ABORTED", err instanceof Error ? err.message : String(err));
		}
		throw err;
	} finally {
		inFlight.delete(requestId);
	}
}

export function registerOgpIpc(): void {
	handle("ogp:fetch", (_event, requestId: string, url: string) => fetchOgpImpl(requestId, url));
	handle("ogp:cancel", (_event, requestId: string) => {
		cancelOgpFetch(requestId);
	});
}

export const __testing = {
	fetchOgpImpl,
	cacheGet,
	cacheSet,
	clearCache: clearOgpCache,
	cancelOgpFetch,
	hasInFlight: (requestId: string) => inFlight.has(requestId),
	CACHE_TTL_MS,
	MAX_CACHE_SIZE,
};
