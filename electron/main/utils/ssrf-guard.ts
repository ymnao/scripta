import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as nodeLookup } from "node:dns";
import { isIPv4, isIPv6 } from "node:net";

// 旧 Tauri 版 src-tauri/src/commands/ogp.rs の `is_global_ip` / `SsrfSafeResolver` を
// JS で 1:1 移植。グローバル到達可能 IP のみを許可する allowlist 方式で
// プライベート / ループバック / リンクローカル / マルチキャスト 等を弾く。
//
// **TOCTOU 防御**:
// 「事前に hostname を resolve → IP 検証 → 接続」の 3 手順を分離すると DNS rebinding
// の窓ができる。`http(s).request({ lookup: safeLookup })` で **接続時の lookup
// コールバック内で検証** することにより、attacker が public IP を返してから private
// IP に切り替えても、実際に接続される IP がチェックされる経路に閉じ込められる。
// 各リダイレクトも別 request として safeLookup を通るので 1 hop ごとに同じ防御が効く。

export function isGlobalIp(ip: string): boolean {
	if (isIPv4(ip)) return isGlobalIpv4(ip);
	if (isIPv6(ip)) return isGlobalIpv6(ip);
	return false;
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

export const safeLookup: SafeLookup = (hostname, options, callback) => {
	const opts = normalizeOptions(options);
	if (opts.all === true) {
		// `{all: true}` 時の callback は `(err, LookupAddress[]) => void`。TS の
		// オーバーロード解決は options の値で narrow されないため明示キャスト。
		const allOpts: LookupOptions & { all: true } = { ...opts, all: true };
		nodeLookup(hostname, allOpts, (err, addresses) => {
			const cb = callback as LookupAllCallback;
			if (err) return cb(err, []);
			for (const a of addresses) {
				if (!isGlobalIp(a.address)) {
					return cb(makeSsrfError(a.address), []);
				}
			}
			cb(null, addresses);
		});
		return;
	}
	// `all: false` オーバーロードは options の number/object 引数に依存して narrow
	// されるが、汎用 LookupOptions では narrow 不能。callback の `address` は
	// 実装上 string になるが TS は `string | LookupAddress[]` と推論するため、
	// branch を runtime で守った上で string にキャストする。family 等の元 options は
	// `...opts` で保持して all のみ false を被せる。
	const singleOpts: LookupOptions = { ...opts, all: false };
	nodeLookup(hostname, singleOpts, (err, address, family) => {
		const cb = callback as LookupSingleCallback;
		if (err) return cb(err, "", 0);
		const addr = address as string;
		if (!isGlobalIp(addr)) return cb(makeSsrfError(addr), "", 0);
		cb(null, addr, family);
	});
};
