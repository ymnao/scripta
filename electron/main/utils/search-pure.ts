// main 側の検索 / 走査 IPC (search.ts / scanUnresolvedWikilinksImpl / scanBacklinksImpl)
// で共有する純関数群。renderer に相当ロジックがあるものは cross-side sync を要する:
//   isAsciiOnly / buildLowerToOrigUtf16Map: src/components/editor/highlight-query.ts
//   isEscaped: src/lib/content.ts
// electron-vite で main / renderer は別 bundle に物理分離されているため import 共有は
// 避けてコードを duplicate する。仕様変更時は両側を同時に更新し、テストベクトルも
// 一致させる（本ファイルのテストは electron/main/utils/search-pure.test.ts）。
//
// 加えて e2e/helpers/electron-api-mock.ts (renderer-only Playwright モック) からも
// 本モジュールの関数を browser scope に inject して同一実装を回す (PR #279)。
// mock は addInitScript の script content 文字列に本モジュールの `.toString()` を差し込む
// 経路を通るため、ここに宣言する関数はすべて **named function** で書く（arrow に
// すると `.toString()` 結果に関数名が現れず inject 側で `const ${fn.name} = ${fn.toString()}`
// が破綻する）。

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

/** 文字列 byte 比較（lexicographic）。localeCompare は使わない — locale 依存で挙動が変わる。 */
export function byteCmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** 各 query char が target に **順序どおり** 含まれるかを判定する fuzzy match。 */
export function fuzzyMatch(query: string, target: string): boolean {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	if (q.length === 0) return true;
	let qi = 0;
	for (const ch of t) {
		if (ch === q[qi]) {
			qi++;
			if (qi === q.length) return true;
		}
	}
	return qi === q.length;
}

/**
 * `pos` の直前に連続する `\` が奇数個あるなら escape されている。
 * `src/lib/content.ts:isEscaped` と同形ロジック（main / renderer で同一判定を保証するため）。
 */
export function isEscaped(text: string, pos: number): boolean {
	let count = 0;
	let i = pos - 1;
	while (i >= 0 && text[i] === "\\") {
		count++;
		i--;
	}
	return count % 2 === 1;
}

/**
 * 本文の各行が本文全体の中で始まる char index を返す。`\r\n` / `\n` どちらの
 * 行区切りでも揃える。`lines.length` 個の要素を返す。
 */
export function buildLineStarts(text: string, lines: readonly string[]): number[] {
	const lineStarts: number[] = new Array(lines.length);
	let pos = 0;
	for (let i = 0; i < lines.length; i++) {
		lineStarts[i] = pos;
		pos += lines[i].length;
		if (pos < text.length && text[pos] === "\r") pos++;
		if (pos < text.length && text[pos] === "\n") pos++;
	}
	return lineStarts;
}

/** `pos` がいずれかの `[from, to)` 範囲に含まれるかを判定する。 */
export function isInRanges(
	pos: number,
	ranges: ReadonlyArray<{ from: number; to: number }>,
): boolean {
	for (const r of ranges) {
		if (r.from <= pos && pos < r.to) return true;
	}
	return false;
}

/**
 * CommonMark 準拠で inline code span 範囲を列挙する。
 * 仕様: N 連続のバックティックを開き delimiter、同じ N 連続を閉じ delimiter とする。
 *       open 側だけは前置 escape (`\\\``) を除外する (scripta の用途上、escape された
 *       backtick で code span を開始させたくないため。CommonMark 上は `\\\`code\\\``
 *       は code span として扱われ得るが、現状の wikilink 判定との整合性を優先する)。
 *       閉じ側では escape を判定しない。CommonMark 上、close の `` ` `` は backtick
 *       string として認識され、直前の `\\` は中身の literal backslash に過ぎないため。
 *       例: `` `foo \\\` [[t]] bar` `` は open=pos 0 / close=pos 5 で code span = `foo \\`
 *       となり、後続の `[[t]]` は code span 外。live-preview の lezer InlineCode と
 *       一致させるためにこの判定にする。
 * 引数 s は 1 行でも本文全体でもよい。CommonMark は code span が改行を跨ぐことを
 * 許容するため、live-preview の lezer InlineCode と整合させるには本文全体で走らせる
 * 必要がある (例: ``` `start\n[[t]]\nend` ``` 形の複数行 span)。
 */
export function collectInlineCodeRanges(s: string): Array<{ from: number; to: number }> {
	const ranges: Array<{ from: number; to: number }> = [];
	let i = 0;
	while (i < s.length) {
		if (s[i] !== "`") {
			i++;
			continue;
		}
		// run の先頭が escape されていれば、その backtick run 全体を skip する。
		// `i++` だけだと同じ run の 2 文字目以降を open delimiter として誤開始してしまう
		// (例: `\\\`\\\` [[t]] \\\`` で 2 文字目から code span を開いてしまう)。
		// Lezer / live-preview の InlineCode 判定もこの run 全体を delimiter としない。
		if (isEscaped(s, i)) {
			let runEnd = i;
			while (runEnd < s.length && s[runEnd] === "`") runEnd++;
			i = runEnd;
			continue;
		}
		const openStart = i;
		let openEnd = i;
		while (openEnd < s.length && s[openEnd] === "`") openEnd++;
		const openLen = openEnd - openStart;
		// 同じ長さの backtick 連続を閉じとして探す。close 側は escape を見ない
		// (上のコメント参照)。
		let k = openEnd;
		let foundCloseEnd = -1;
		while (k < s.length) {
			if (s[k] !== "`") {
				k++;
				continue;
			}
			let closeEnd = k;
			while (closeEnd < s.length && s[closeEnd] === "`") closeEnd++;
			if (closeEnd - k === openLen) {
				foundCloseEnd = closeEnd;
				break;
			}
			// 長さが違うバックティック列はスキップ (同じ run の途中で長さが違う閉じは無効)。
			k = closeEnd;
		}
		if (foundCloseEnd !== -1) {
			ranges.push({ from: openStart, to: foundCloseEnd });
			i = foundCloseEnd;
		} else {
			// 閉じが無ければ open delimiter はリテラル。次の文字から再開して探索を続ける。
			i = openEnd;
		}
	}
	return ranges;
}

/**
 * 指定 line index 集合の範囲を space に置換した text を返す。length は元と一致する。
 * inline code scanner に「対象範囲の文字を空白として見せる」用途で、char index は
 * 元の text と互換 (lineStarts / openOffset の換算がそのまま使える)。
 */
export function maskRanges(
	text: string,
	lines: readonly string[],
	lineStarts: readonly number[],
	mask: readonly boolean[],
): string {
	const buf = text.split("");
	for (let i = 0; i < lines.length; i++) {
		if (!mask[i]) continue;
		const start = lineStarts[i];
		const end = start + lines[i].length;
		for (let j = start; j < end; j++) buf[j] = " ";
	}
	return buf.join("");
}

/**
 * CommonMark / Lezer 準拠の fenced code block 判定。
 * - opener: 行頭 0-3 spaces の後に ``` または ~~~ (3 個以上の連続)。info string は OK
 * - closer: opener と同じ文字種、opener 以上の長さ、後ろは空白 (space/tab) のみ
 * - 4 spaces 以上 indent の行は fence marker として認識しない (CommonMark の
 *   indented code block と区別)
 * 旧実装は `trimmed.startsWith("```") || trimmed.startsWith("~~~")` で単純 toggle
 * していたため、異なる文字種の closer / 長さ違い closer / 過剰 indent ですべて
 * close と誤判定し live-preview と乖離していた。
 */
export function findFencedLines(lines: readonly string[]): boolean[] {
	const flags: boolean[] = new Array(lines.length).fill(false);
	let opener: { ch: string; length: number } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		let indent = 0;
		while (indent < line.length && line[indent] === " ") indent++;
		// 4 spaces 以上 indent の行は fence marker として認識しない。fenced 中なら
		// その行は fenced 範囲のテキストとして扱う。
		if (indent >= 4) {
			if (opener !== null) flags[i] = true;
			continue;
		}
		const ch = line[indent];
		let markerLen = 0;
		if (ch === "`" || ch === "~") {
			while (indent + markerLen < line.length && line[indent + markerLen] === ch) markerLen++;
		}
		if (markerLen >= 3) {
			if (opener === null) {
				// opener: info string (markerLen 以降のテキスト) は許容。
				// ただし backtick fence (```) の info string に backtick は含められない
				// (CommonMark / Lezer)。例えば ``` info `x` は fence opener ではなく
				// paragraph として扱われる。
				const afterMarker = line.slice(indent + markerLen);
				if (ch === "`" && afterMarker.includes("`")) {
					continue;
				}
				opener = { ch, length: markerLen };
				flags[i] = true;
				continue;
			}
			// closer 候補: 同じ文字種・長さ ≥ opener・後ろは空白のみ。
			const afterMarker = line.slice(indent + markerLen);
			if (ch === opener.ch && markerLen >= opener.length && /^[ \t]*$/.test(afterMarker)) {
				opener = null;
				flags[i] = true;
				continue;
			}
			// closer 条件を満たさない marker 行は fenced 内のテキスト扱い。
			flags[i] = true;
			continue;
		}
		if (opener !== null) flags[i] = true;
	}
	return flags;
}
