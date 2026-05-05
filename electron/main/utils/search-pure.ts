// NOTE: keep in sync with src/components/editor/highlight-query.ts
// 同じ意味論の関数が renderer 側にも存在する。electron-vite で main / renderer は
// 別 bundle に物理分離されているため import 共有は避けてコードを duplicate する。
// 仕様変更時は両側を同時に更新すること（テストケースも一致させてある）。

/** ASCII 文字のみで構成されるかを判定する。 */
export function isAsciiOnly(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 127) return false;
	}
	return true;
}

/**
 * `text.toLowerCase()` 上の UTF-16 code unit 位置から、元の `text` 上の
 * UTF-16 code unit 位置への逆引きマップを構築する。ASCII-only のときは
 * `null` を返す（マップ不要、indexOf 結果をそのまま使える）。
 *
 * `toLowerCase()` は文字列長を変える可能性がある（例: `İ` U+0130 →
 * `i\u{0307}`）。lowercased 文字列で見つかった offset を元の文字列で使う前に
 * このマップ経由で逆引きする必要がある。
 *
 * 返り値の長さは `text.toLowerCase().length + 1`（末尾 sentinel が
 * `text.length` を返す）。
 */
export function buildLowerToOrigUtf16Map(text: string): number[] | null {
	if (isAsciiOnly(text)) return null;
	const map: number[] = [];
	let origOffset = 0;
	for (const ch of text) {
		const origLen = ch.length;
		const lowerLen = ch.toLowerCase().length;
		for (let i = 0; i < lowerLen; i++) {
			map.push(origOffset);
		}
		origOffset += origLen;
	}
	map.push(origOffset);
	return map;
}
