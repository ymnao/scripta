import { SCRIPTA_ASSET_SCHEME } from "./scripta-asset-protocol";

// 「リモート画像を読み込む」設定 (`loadRemoteImages`, 既定 true) の強制ロジック。
//
// markdown の `![](https://...)` と OGP リンクカードの `og:image` は、どちらも
// renderer の `<img src>` として **任意ホストへ自動 fetch** される。前者は本人が
// 書いた URL だが、後者は**リンク先サーバーが返した HTML** が URL を決めるため、
// ノートを開いただけで第三者ホストへ IP / User-Agent が渡る。これを止められる
// 手段が無かったので設定を追加した (既定は従来どおり許可)。
//
// **本設定が止めるのは `<img>` のロードだけ**である点に注意。リンクカードの元に
// なる OGP HTML 取得 (ipc/ogp.ts の fetchOgpImpl) 自体はここを通らず、その可否は
// 既存の `showLinkCards` 設定が持つ。つまり「カードは出すが画像は取りに行かない」
// が本設定 OFF の状態で、「そもそもリンク先へ触れない」は showLinkCards OFF。
//
// 強制は 2 層にする:
//   1. `buildCsp` — CSP の `img-src` から `https:` を落とす (宣言的な多層防御)
//   2. `shouldBlockImageRequest` — `webRequest.onBeforeRequest` で image を cancel
//
// CSP だけだと **document 単位**なので、設定を切り替えた瞬間には効かず reload が
// 要る。webRequest 側が即時性を担保するので UI に再起動の注記は要らない。逆に
// ON へ戻したときも webRequest が即座に解放し、CSP は次ロードから緩む
// (「緩める」方向の遅れは安全側なので許容)。
//
// ただし webRequest が介入できるのは **request が発行された場合だけ**なので、OFF に
// する前に取得済みで Chromium の memory cache に載っている画像は、同一 document 内で
// widget が作り直された際に request なしで再表示されうる。新たな egress は起きない
// (取得済みのものが見えるだけ) ので実害は無く、reload 後は CSP 層が閉じる。

function buildImgSrc(allowRemoteImages: boolean): string {
	// `data:` / `blob:` / `scripta-asset:` は OFF でも必ず残す。ローカル画像は
	// scripta-asset:// 経由 (ADR-0002)、mermaid 等の生成物は blob:/data: で載る
	// ため、ここを落とすとオフライン用途まで壊れる。`file:` は ON/OFF 問わず
	// 許可しない (任意ローカルファイル読み取り経路になるため。ADR-0002 参照)。
	const parts = [
		"'self'",
		...(allowRemoteImages ? ["https:"] : []),
		"data:",
		"blob:",
		`${SCRIPTA_ASSET_SCHEME}:`,
	];
	return `img-src ${parts.join(" ")}`;
}

export function buildCsp(isDev: boolean, allowRemoteImages: boolean): string {
	return [
		"default-src 'self'",
		// dev は Vite の HMR client が inline script を注入するため 'unsafe-inline' が要る。
		isDev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		buildImgSrc(allowRemoteImages),
		"font-src 'self' data:",
		// dev は Vite dev server への HMR websocket / module fetch を許可する。
		isDev ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'self'",
		"worker-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'self'",
	].join("; ");
}

// defaultSession の `onBeforeRequest` から呼ばれる。true を返した request は cancel。
//
// `devOrigin` は dev 時の Vite dev server origin (`ELECTRON_RENDERER_URL` の origin)。
// dev では renderer 自体が http://localhost:* から配信されるため、アプリ同梱の画像
// (public/ 配下のアイコン等) まで巻き込んで block してしまう。origin 一致で除外する。
// prod は renderer が file: なので null を渡す。
// `onBeforeRequest` の details をそのまま渡せる形にしてある。url と resourceType を
// 個別の string 引数にすると、隣り合った同型引数を取り違えても型で気付けない。
export interface ImageRequestDetails {
	url: string;
	resourceType: string;
}

export function shouldBlockImageRequest(
	details: ImageRequestDetails,
	allowRemoteImages: boolean,
	devOrigin: string | null,
): boolean {
	if (allowRemoteImages) return false;
	// 遮断対象は画像だけ。script / stylesheet / xhr 等は本設定の管轄外
	// (それらは CSP の default-src / connect-src 'self' が既に閉じている)。
	if (details.resourceType !== "image") return false;
	let parsed: URL;
	try {
		parsed = new URL(details.url);
	} catch {
		// parse 不能な URL は「リモートである」と判定できないので通す。
		// http(s) 以外は onBeforeRequest の urls フィルタで元々届かない。
		return false;
	}
	// http(s) の判定に utils/url.ts の `isSafeExternalUrl` は使わない。あちらは
	// 「外部ブラウザに渡して安全か」という別ポリシーで、将来 https 限定に絞られると
	// ここの http 画像遮断が黙って fail-open する結合になるため。
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	if (devOrigin !== null && parsed.origin === devOrigin) return false;
	return true;
}
