import type { LookupAddress, LookupOptions } from "node:dns";
import { promises as dnsPromises } from "node:dns";
import { isIP, isIPv4, isIPv6 } from "node:net";

// `is_global_ip` / `SsrfSafeResolver`。グローバル到達可能 IP のみを許可する
// allowlist 方式で、プライベート / ループバック / リンクローカル / マルチキャスト
// 等を弾く。
//
// **DNS rebinding 防御 (pinSafeLookup)**:
// 「事前に hostname を resolve → IP 検証 → 接続」を分離すると、validation 後に
// 攻撃者の DNS が返答を切り替える窓が開く可能性がある（TOCTOU）。本モジュールでは
// `pinSafeLookup` で **解決済み IP を 1 度だけ取得して pin** し、http(s).request の
// `lookup` フックには pin を返すだけの sync コールバックを渡す。これにより:
//   1. dns.lookup の呼び出しは pin 作成時の 1 回のみ（攻撃者の rebind は反映されない）
//   2. connect 時に Node が呼ぶ lookup フックは保存済み IP を即時返却（追加 DNS なし）
//   3. 各 redirect は別 hop として再 pin されるので 1 hop ごとに同じ防御が効く
//
// IP リテラルは Node の `net.connect` が dns.lookup を経由せず直接 connect する
// 経路があり、`lookup` フックだけでは literal-IP SSRF を貫通させてしまう。pin 作成
// 時に `isIP` で検出して isGlobalIp 判定を pin 内に集約することで「pinSafeLookup を
// 通った時点で安全」と単一不変条件で保証する。

export function isGlobalIp(ip: string): boolean {
	if (isIPv4(ip)) return isGlobalIpv4(ip);
	if (isIPv6(ip)) return isGlobalIpv6(ip);
	return false;
}

// IPv6 リテラル URL の `URL.hostname` は `"[::1]"` の **bracket 付き** で返るが、
// Node の `dns.lookup` / `RequestOptions.hostname` / `net.isIP` はいずれも bracket
// なしを期待する。SSRF 判定 / 接続 / 表示で host を扱う箇所はこのヘルパで正規化する。
export function stripIpBrackets(host: string): string {
	if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
	return host;
}

function isGlobalIpv4(ip: string): boolean {
	const parts = ip.split(".");
	if (parts.length !== 4) return false;
	const octets: number[] = [];
	for (const p of parts) {
		if (!/^\d+$/.test(p)) return false;
		const n = Number(p);
		if (!Number.isInteger(n) || n < 0 || n > 255) return false;
		octets.push(n);
	}
	const [a, b, c] = octets;
	if (a === 0) return false; // 0.0.0.0/8 ("This network")
	if (a === 127) return false; // 127.0.0.0/8 loopback
	if (a === 10) return false; // 10/8 private
	if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12 private
	if (a === 192 && b === 168) return false; // 192.168/16 private
	if (a === 169 && b === 254) return false; // 169.254/16 link-local
	if (a === 100 && (b & 0xc0) === 64) return false; // 100.64/10 CGNAT
	if (a === 192 && b === 0 && c === 0) return false; // 192.0.0/24 IETF protocol assignments
	if (a === 192 && b === 0 && c === 2) return false; // 192.0.2/24 TEST-NET-1
	if (a === 198 && (b & 0xfe) === 18) return false; // 198.18/15 benchmarking
	if (a === 198 && b === 51 && c === 100) return false; // 198.51.100/24 TEST-NET-2
	if (a === 203 && b === 0 && c === 113) return false; // 203.0.113/24 TEST-NET-3
	if ((a & 0xf0) === 224) return false; // 224.0.0.0/4 multicast
	if (a >= 240) return false; // 240.0.0.0/4 reserved + broadcast
	return true;
}

function isGlobalIpv6(ip: string): boolean {
	const segs = expandIpv6(ip);
	if (segs === null) return false;
	if ((segs[0] & 0xe000) !== 0x2000) return false; // not in 2000::/3 (global unicast)
	if (segs[0] === 0x2001 && segs[1] === 0x0db8) return false; // 2001:db8::/32 documentation
	if (segs[0] === 0x2001 && segs[1] < 0x0200) return false; // 2001::/23 IETF protocol assignments
	if (segs[0] === 0x2002) return false; // 2002::/16 6to4 (deprecated)
	return true;
}

// "::1" / "fe80::1%eth0" / "2001:db8::1" を 8 セグメント配列に展開する。
// IPv4-mapped 形式 (::ffff:1.2.3.4) は IPv4 部の 32bit を 16bit×2 に分配して扱う。
function expandIpv6(ip: string): number[] | null {
	const noZone = ip.split("%")[0];
	if (noZone.length === 0) return null;
	const parts = noZone.split("::");
	if (parts.length > 2) return null;

	const headRaw = parts[0] === "" ? [] : parts[0].split(":");
	const tailRaw = parts.length === 2 ? (parts[1] === "" ? [] : parts[1].split(":")) : [];

	// IPv4-mapped: 末尾の "a.b.c.d" を 16bit×2 に展開
	function unpackIpv4Trailing(arr: string[]): string[] | null {
		if (arr.length === 0) return arr;
		const last = arr[arr.length - 1];
		if (!last.includes(".")) return arr;
		if (!isIPv4(last)) return null;
		const oct = last.split(".").map(Number);
		const hi = ((oct[0] << 8) | oct[1]).toString(16);
		const lo = ((oct[2] << 8) | oct[3]).toString(16);
		return [...arr.slice(0, -1), hi, lo];
	}
	const head = unpackIpv4Trailing(headRaw);
	const tail = unpackIpv4Trailing(tailRaw);
	if (head === null || tail === null) return null;

	const explicit = head.length + tail.length;
	if (parts.length === 1 && explicit !== 8) return null;
	if (parts.length === 2 && explicit > 7) return null;
	const fillCount = parts.length === 2 ? 8 - explicit : 0;

	const segs: number[] = [];
	for (const h of head) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
		segs.push(parseInt(h, 16));
	}
	for (let i = 0; i < fillCount; i++) segs.push(0);
	for (const t of tail) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(t)) return null;
		segs.push(parseInt(t, 16));
	}
	if (segs.length !== 8) return null;
	for (const s of segs) {
		if (!Number.isInteger(s) || s < 0 || s > 0xffff) return null;
	}
	return segs;
}

// http(s).request の `lookup` 互換シグネチャ。Node の `dns.lookup` 公開 API は
// `(hostname, family, callback)` / `(hostname, options, callback)` / `(hostname, callback)`
// の 3 形を受けるため、`options` は number / undefined / object のいずれにもなり得る。
// 内部で全てオブジェクトに正規化して family 等の指定を保持しつつ、解決後 IP が
// global でなければ EACCES で reject する。
type LookupSingleCallback = (
	err: NodeJS.ErrnoException | null,
	address: string,
	family: number,
) => void;
type LookupAllCallback = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void;

// 入力 options は number (= family) / undefined / オブジェクト の 3 種を許容する。
// `dns.LookupFunction` 相当（http.request の lookup 用フック）の幅広い呼び出しを
// 受けられるようにし、内部処理の前に必ず LookupOptions オブジェクトに正規化する。
export type SafeLookup = (
	hostname: string,
	options: LookupOptions | number | undefined,
	callback: LookupSingleCallback | LookupAllCallback,
) => void;

function makeSsrfError(addr: string): NodeJS.ErrnoException {
	const e = new Error(`SSRF blocked: non-global IP ${addr}`) as NodeJS.ErrnoException;
	e.code = "EACCES";
	return e;
}

function normalizeOptions(options: LookupOptions | number | undefined): LookupOptions {
	if (typeof options === "number") return { family: options };
	if (options === undefined || options === null) return {};
	return options;
}

// dns.lookup は内部で libuv worker thread の getaddrinfo を呼ぶため AbortSignal や
// cancel API を持たない。timeout 経過時は Promise.race で JS 側を unblock し、
// 背景の worker は名前解決完了まで動き続ける（worker thread を消費するが OGP fetch
// の per-request budget を守るのが本来の目的なのでそれで十分）。
async function lookupWithTimeout(
	host: string,
	timeoutMs: number,
): Promise<{ address: string; family: number }> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			dnsPromises.lookup(host),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					const err = new Error(`DNS lookup timeout after ${timeoutMs}ms`) as NodeJS.ErrnoException;
					err.code = "ETIMEDOUT";
					reject(err);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface PinnedLookup {
	// http(s).request({ lookup }) に渡す sync コールバック。dns.lookup を呼ばず、
	// pin 作成時に validate された IP を即時返却する。
	lookup: SafeLookup;
	// pin された IP（IPv4 / IPv6 リテラル）。
	address: string;
	// dns.LookupAddress.family と同じ値（4 または 6）。
	family: number;
}

// `host` を 1 度だけ解決して global IP に validate し、その IP に固定された
// `lookup` フックを返す。host は URL.hostname の bracket を剥いた形で渡す。
// IPv4 / IPv6 リテラルは dns.lookup を使わず isGlobalIp で直接判定する。
//
// `timeoutMs` は DNS 解決の上限。dns.lookup は libuv worker thread 内の
// getaddrinfo を直接呼ぶため AbortSignal を持たず、Promise.race でしか中断
// できない。timeout 後も worker は名前解決完了まで動き続けるが、JS 側は
// ETIMEDOUT を投げて呼び出し元の per-request budget を守る。literal IP の
// 場合は dns.lookup 不要なので timeoutMs は無視される。
//
// 戻り値の `lookup` を `http(s).request({ lookup })` に渡せば、Node は pin された
// IP に直接 connect する（DNS 再問い合わせは入らない）。Host ヘッダ / SNI / 証明書
// 検証は元の URL.hostname がそのまま使われるので、HTTPS の name validation は維持。
export async function pinSafeLookup(host: string, timeoutMs: number): Promise<PinnedLookup> {
	const literalFamily = isIP(host); // 0 (= not IP) / 4 / 6
	let address: string;
	let family: number;
	if (literalFamily !== 0) {
		address = host;
		family = literalFamily;
	} else {
		const resolved = await lookupWithTimeout(host, timeoutMs);
		address = resolved.address;
		family = resolved.family;
	}
	if (!isGlobalIp(address)) {
		throw makeSsrfError(address);
	}
	const lookup: SafeLookup = (_hostname, options, callback) => {
		const opts = normalizeOptions(options);
		// 要求 family が pin と不一致なら失敗扱い。0 / undefined は any として通す。
		// hints / verbatim は pin 後 DNS 経路を通らないので無視で問題なし。family を
		// 尊重しないと「IPv6 を頼んだのに IPv4 が返る」silent contract 違反になる。
		if (opts.family !== undefined && opts.family !== 0 && opts.family !== family) {
			const err = new Error(
				`pinned lookup family mismatch: requested ${opts.family}, pinned ${family}`,
			) as NodeJS.ErrnoException;
			err.code = "EAI_FAIL";
			if (opts.all === true) (callback as LookupAllCallback)(err, []);
			else (callback as LookupSingleCallback)(err, "", 0);
			return;
		}
		if (opts.all === true) {
			(callback as LookupAllCallback)(null, [{ address, family }]);
		} else {
			(callback as LookupSingleCallback)(null, address, family);
		}
	};
	return { lookup, address, family };
}
