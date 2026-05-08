// preload の `convertFileSrc` と main の protocol handler、および各種テスト mock が
// 同一ロジックで URL を組み立てる/分解するために、純粋関数として切り出している。
// 本ファイルは electron / Node API いずれにも依存しないので preload / main / renderer
// 側テストどこからでも import 可能。

/**
 * 絶対パス（Unix `/foo/bar` または Windows `C:\Users\bar` / `C:/Users/bar`）から
 * `scripta-asset://` URL を組み立てる。`new URL()` で確実にパース可能 (`hostname ===
 * "localhost"`、`hash`/`search` に分断されない) であることを保証する。
 *
 *   - Windows の `\` は URL pathname で legal ではないので `/` に正規化する
 *   - leading `/` がないと `localhost` 直後にパスが続いて authority に巻き込まれる
 *     例: `scripta-asset://localhostC:/...` は new URL で `Invalid URL` になる
 *   - `#` / `?` を含む path は per-segment `encodeURIComponent` で escape する
 *     （`encodeURI` は `#` / `?` を escape せず pathname/hash/search に分断される）
 */
export function buildScriptaAssetUrl(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const withLeading = normalized.startsWith("/") ? normalized : `/${normalized}`;
	const encoded = withLeading.split("/").map(encodeURIComponent).join("/");
	return `scripta-asset://localhost${encoded}`;
}

/**
 * `scripta-asset://` URL の `pathname`（percent-encoded のまま）を OS のファイルパス
 * に戻す。`buildScriptaAssetUrl` の逆操作。
 *
 * `/C:/Users/img.png` のような leading-slash + drive-letter 形式は leading `/` を除去
 * して `C:/Users/img.png` 形式に戻す（Node の path API が絶対パスとして扱える形）。
 * Unix 上で攻撃者が `/Z:/...` 形式を投げても、変換結果 `Z:/...` は `path.isAbsolute`
 * が false になるため後段の `validatePath` で弾かれる（fail-closed）。
 */
export function urlPathnameToFsPath(pathname: string): string {
	const decoded = decodeURIComponent(pathname);
	return /^\/[A-Za-z]:\//.test(decoded) ? decoded.slice(1) : decoded;
}
