/**
 * Check if a Unicode code point is East Asian Fullwidth or Wide.
 * Approximation based on Unicode block ranges — no external dependencies.
 */
export function isEastAsianFullwidth(cp: number): boolean {
	// CJK Unified Ideographs
	if (cp >= 0x4e00 && cp <= 0x9fff) return true;
	// CJK Unified Ideographs Extension A
	if (cp >= 0x3400 && cp <= 0x4dbf) return true;
	// CJK Unified Ideographs Extension B–F
	if (cp >= 0x20000 && cp <= 0x2fa1f) return true;
	// CJK Unified Ideographs Extension G
	if (cp >= 0x30000 && cp <= 0x3134f) return true;
	// CJK Unified Ideographs Extension H
	if (cp >= 0x31350 && cp <= 0x323af) return true;
	// CJK Compatibility Ideographs
	if (cp >= 0xf900 && cp <= 0xfaff) return true;
	// CJK Compatibility Ideographs Supplement
	if (cp >= 0x2f800 && cp <= 0x2fa1f) return true;
	// Hiragana
	if (cp >= 0x3040 && cp <= 0x309f) return true;
	// Katakana
	if (cp >= 0x30a0 && cp <= 0x30ff) return true;
	// Katakana Phonetic Extensions
	if (cp >= 0x31f0 && cp <= 0x31ff) return true;
	// Bopomofo
	if (cp >= 0x3100 && cp <= 0x312f) return true;
	// Bopomofo Extended
	if (cp >= 0x31a0 && cp <= 0x31bf) return true;
	// Hangul Syllables
	if (cp >= 0xac00 && cp <= 0xd7af) return true;
	// Hangul Jamo
	if (cp >= 0x1100 && cp <= 0x11ff) return true;
	// Hangul Jamo Extended-A
	if (cp >= 0xa960 && cp <= 0xa97f) return true;
	// Hangul Jamo Extended-B
	if (cp >= 0xd7b0 && cp <= 0xd7ff) return true;
	// Hangul Compatibility Jamo
	if (cp >= 0x3130 && cp <= 0x318f) return true;
	// Fullwidth Forms
	if (cp >= 0xff01 && cp <= 0xff60) return true;
	if (cp >= 0xffe0 && cp <= 0xffe6) return true;
	// CJK Symbols and Punctuation
	if (cp >= 0x3000 && cp <= 0x303f) return true;
	// Enclosed CJK Letters and Months
	if (cp >= 0x3200 && cp <= 0x32ff) return true;
	// CJK Compatibility
	if (cp >= 0x3300 && cp <= 0x33ff) return true;
	// CJK Compatibility Forms
	if (cp >= 0xfe30 && cp <= 0xfe4f) return true;
	// Ideographic Description Characters
	if (cp >= 0x2ff0 && cp <= 0x2fff) return true;
	// Kanbun
	if (cp >= 0x3190 && cp <= 0x319f) return true;
	// CJK Strokes
	if (cp >= 0x31c0 && cp <= 0x31ef) return true;
	// Yi Syllables
	if (cp >= 0xa000 && cp <= 0xa48f) return true;
	// Yi Radicals
	if (cp >= 0xa490 && cp <= 0xa4cf) return true;
	return false;
}

/**
 * Get the display width of a string, considering East Asian Fullwidth characters.
 */
export function getStringWidth(str: string): number {
	let width = 0;
	for (const char of str) {
		const cp = char.codePointAt(0);
		if (cp !== undefined && isEastAsianFullwidth(cp)) {
			width += 2;
		} else {
			width += 1;
		}
	}
	return width;
}
