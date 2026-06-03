import { URL } from "node:url";
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
	// 期限切れの除去と最古エントリ探索を 1 パスに統合する。500 件規模で従来は
	// 2 回イテレートしていたところを 1 回にし、cacheSet が link card 描画の
	// hot path で呼ばれる前提で per-insert オーバーヘッドを半減させる。
	let oldestKey: string | null = null;
	let oldestTime = Number.POSITIVE_INFINITY;
	for (const [k, v] of cache) {
		if (now - v.fetchedAt >= CACHE_TTL_MS) {
			cache.delete(k);
			continue;
		}
		if (v.fetchedAt < oldestTime) {
			oldestTime = v.fetchedAt;
			oldestKey = k;
		}
	}
	// 期限切れ掃除後に容量超過していて、かつ新規キーなら最古を evict する。
	// 既存 url の上書きは「容量を増やさない」のでこの分岐に入らない。
	if (!cache.has(url) && cache.size >= MAX_CACHE_ENTRIES && oldestKey !== null) {
		cache.delete(oldestKey);
	}
	cache.set(url, { data, fetchedAt: now });
}

export function clearOgpCache(): void {
	cache.clear();
}

// in-flight な fetch の cancel 用 controller を URL 単位で保持。同一 URL に対し
// 複数 view から同時 fetch があった場合は後勝ち（Map.set で上書き）。識別子チェック
// 付き unregister により displaced な fetch の completion 時にもエントリを壊さない。
const inFlight = new Map<string, AbortController>();

export function cancelOgpFetch(url: string): void {
	inFlight.get(url)?.abort();
}

async function fetchWithRedirects(
	urlStr: string,
	signal: AbortSignal,
): Promise<{ contentType: string; body: Buffer }> {
	let current = urlStr;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
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
		const pin = await pinSafeLookup(bareHost, REQUEST_TIMEOUT_MS);
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

async function fetchOgpImpl(url: string): Promise<OgpData> {
	const lower = url.toLowerCase();
	if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
		throw new Error("Only http and https URLs are supported");
	}
	const cached = cacheGet(url);
	if (cached) return cached;

	const controller = new AbortController();
	inFlight.set(url, controller);
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
		// IPC 越しに `err.name` は保たれないので、cancel 経路は ErrorKind="ABORTED"
		// の StructuredError へ変換して renderer に渡す（renderer は getErrorKind で
		// 判別し、cache 汚染を回避する）。
		if (err instanceof AbortError) {
			throw new StructuredError("ABORTED", err.message);
		}
		throw err;
	} finally {
		// 同一 URL に対する後発 fetch が Map を上書きしている可能性があるので、
		// 自分の controller が現役のときだけ削除する。
		if (inFlight.get(url) === controller) inFlight.delete(url);
	}
}

export function registerOgpIpc(): void {
	handle("ogp:fetch", (_event, url: string) => fetchOgpImpl(url));
	handle("ogp:cancel", (_event, url: string) => {
		cancelOgpFetch(url);
	});
}

export const __testing = {
	fetchOgpImpl,
	cacheGet,
	cacheSet,
	clearCache: clearOgpCache,
	cancelOgpFetch,
	hasInFlight: (url: string) => inFlight.has(url),
	CACHE_TTL_MS,
	MAX_CACHE_ENTRIES,
};
