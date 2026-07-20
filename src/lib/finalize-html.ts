import DOMPurify from "dompurify";

/**
 * sanitize 未実施の HTML 文字列を表す branded type。
 *
 * `markdownToHtmlRaw` と post-processor (`resolveHtmlImageSrcs` /
 * `embedHtmlImagesAsDataUri`) はこの型で HTML を受け渡し、最終的に
 * `finalizeHtml` を通してのみ plain `string` に戻る。誤って sink
 * (`dangerouslySetInnerHTML` / ファイル書き出し / `printToPDF`) に
 * `UnsanitizedHtml` を直接渡すコードは、`string` を期待する API に
 * 対しては通ってしまう (branded → base は assignable) が、finalize を
 * 忘れた caller は「plain string を返さない」ため他の string ユーティリティ
 * とのインピーダンスミスマッチで気付きやすくなる。
 */
export type UnsanitizedHtml = string & { readonly __brand: "unsanitized-html" };

/** raw HTML 生成関数 (markdownToHtmlRaw / post-processor) が返り値を branded type にキャストする際のヘルパ。 */
export function markUnsanitized(html: string): UnsanitizedHtml {
	return html as UnsanitizedHtml;
}

export interface FinalizeHtmlOptions {
	/**
	 * `scripta-asset://` scheme の img[src] 等を許可する (preview / PDF export 経路)。
	 *
	 * DOMPurify default の `IS_ALLOWED_URI` は http/https/mailto/tel 等を許可するが
	 * scripta-asset: は含まないため、その scheme を通す経路のみ true にする。
	 *
	 * NOTE: `data:image/*` は DOMPurify default が `<img>` 等に対して既に許可 (dompurify
	 * の DATA_URI_TAGS に img/video/audio/source が含まれる) するため、HTML export 経路
	 * (`data:` を埋め込む) 用の追加オプションは不要。`data:text/html` は default で
	 * strip される (XSS ベクタとして既知)。
	 */
	allowAssetProtocol?: boolean;
}

// DOMPurify 3.x が既定で使う `IS_ALLOWED_URI` regexp (dompurify src の seal 済み regexp と同形)。
// この default を保持したまま scripta-asset: だけ or 結合する。javascript: 等を防ぐ
// 「scheme 名の直後が scheme-char でも `:` でもなければ通す」ロジックを崩さないため、
// default source は改変しない (自前で組み立てると javascript:alert(1) が通る等のレグレッションを起こす)。
const DEFAULT_URI_REGEXP_SOURCE =
	"^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))";
const ASSET_URI_REGEXP_SOURCE = "^scripta-asset:";

function buildUriRegexp(opts: FinalizeHtmlOptions): RegExp {
	if (!opts.allowAssetProtocol) return new RegExp(DEFAULT_URI_REGEXP_SOURCE, "i");
	return new RegExp(`(?:${DEFAULT_URI_REGEXP_SOURCE})|(?:${ASSET_URI_REGEXP_SOURCE})`, "i");
}

// KaTeX が出力する HTML/MathML の tag / attr allowlist。
// 公式 https://katex.org/docs/security 準拠 + 実出力 (span/mathml chain) に必要な最小。
// on* / href / xlink:href / formaction 等は含めない (KaTeX は使わない)。
const KATEX_ADD_TAGS = [
	"math",
	"annotation",
	"semantics",
	"mrow",
	"mi",
	"mo",
	"mn",
	"ms",
	"mtext",
	"msup",
	"msub",
	"msubsup",
	"mover",
	"munder",
	"munderover",
	"mfrac",
	"msqrt",
	"mroot",
	"mtable",
	"mtr",
	"mtd",
	"mspace",
	"mstyle",
	"mpadded",
	"mphantom",
	"menclose",
	"mfenced",
];

const KATEX_ADD_ATTR = [
	"encoding",
	"mathvariant",
	"aria-hidden",
	"aria-label",
	"display",
	"displaystyle",
	"scriptlevel",
	"stretchy",
	"lspace",
	"rspace",
	"minsize",
	"maxsize",
	"width",
	"height",
	"depth",
];

/**
 * post-processor 適用後の HTML に対して最終 sanitize を実施し plain string に戻す。
 *
 * ## 設計方針 (sanitize-after pattern)
 *
 * 従来は `markdownToHtml` 内部で `DOMPurify.sanitize` → その後に post-processor
 * (`resolveHtmlImageSrcs` の DOMParser reparse + img[src] 書き換え, `embedHtmlImagesAsDataUri`
 * の DOMParser reparse + data URI 埋め込み) が続くため、sanitize と実際の sink の間に
 * "reparse → attribute rewrite → serialize" window が残っていた。理論的 mutation-XSS
 * 面 (session 113 で defer された defense-in-depth 懸念) を潰すため、post-processor 適用
 * **後**に一度だけ sanitize する形へ移行する。
 *
 * ## 冪等性
 *
 * `finalizeHtml(finalizeHtml(x, opts), opts) === finalizeHtml(x, opts)` を仕様として持つ
 * (誤って二重に呼ばれても attribute 順序等が安定するように、DOMPurify の determinism に
 * 依存する)。テストで固定する。
 */
export function finalizeHtml(html: UnsanitizedHtml, opts: FinalizeHtmlOptions = {}): string {
	return DOMPurify.sanitize(html, {
		ADD_TAGS: KATEX_ADD_TAGS,
		ADD_ATTR: KATEX_ADD_ATTR,
		ALLOWED_URI_REGEXP: buildUriRegexp(opts),
	});
}
