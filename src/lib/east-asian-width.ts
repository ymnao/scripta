/**
 * Check if a Unicode code point is East Asian Fullwidth or Wide.
 * Based on Unicode block ranges — no external dependencies.
 */
export function isEastAsianFullwidth(cp: number): boolean {
	// CJK Unified Ideographs
	if (cp >= 0x4e00 && cp <= 0x9fff) return true;
	// CJK Unified Ideographs Extension A
	if (cp >= 0x3400 && cp <= 0x4dbf) return true;
	// CJK Unified Ideographs Extension B–F
	if (cp >= 0x20000 && cp <= 0x2fa1f) return true;
	// CJK Compatibility Ideographs
	if (cp >= 0xf900 && cp <= 0xfaff) return true;
	// Hiragana
	if (cp >= 0x3040 && cp <= 0x309f) return true;
	// Katakana
	if (cp >= 0x30a0 && cp <= 0x30ff) return true;
	// Katakana Phonetic Extensions
	if (cp >= 0x31f0 && cp <= 0x31ff) return true;
	// Hangul Syllables
	if (cp >= 0xac00 && cp <= 0xd7af) return true;
	// Hangul Jamo
	if (cp >= 0x1100 && cp <= 0x11ff) return true;
	// Fullwidth Forms
	if (cp >= 0xff01 && cp <= 0xff60) return true;
	if (cp >= 0xffe0 && cp <= 0xffe6) return true;
	// CJK Symbols and Punctuation
	if (cp >= 0x3000 && cp <= 0x303f) return true;
	// Enclosed CJK Letters and Months
	if (cp >= 0x3200 && cp <= 0x32ff) return true;
	// CJK Compatibility
	if (cp >= 0x3300 && cp <= 0x33ff) return true;
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
