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
 * Windows のみ `/C:/Users/img.png` のような leading-slash + drive-letter 形式から
 * leading `/` を除去して `C:/Users/img.png` 形式に戻す（Node path API が drive 付き
 * 絶対パスとして扱える形）。POSIX では `/C:/...` 自体が `C:` ディレクトリ配下を指す
 * 合法な絶対パスなので strip しない（strip すると `validatePath` で `must be absolute`
 * になり 403 で誤って弾かれる）。
 *
 * `platform` 引数はテスト用の上書き。default は呼び出し側プロセスの `process.platform`。
 */
export function urlPathnameToFsPath(
	pathname: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const decoded = decodeURIComponent(pathname);
	if (platform === "win32" && /^\/[A-Za-z]:\//.test(decoded)) {
		return decoded.slice(1);
	}
	return decoded;
}
