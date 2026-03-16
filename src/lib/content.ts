/** Check whether the character at `pos` in `text` is escaped by an odd number of preceding backslashes. */
export function isEscaped(text: string, pos: number): boolean {
	let count = 0;
	let i = pos - 1;
	while (i >= 0 && text[i] === "\\") {
		count++;
		i--;
	}
	return count % 2 === 1;
}

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function processContent(content: string, trimWhitespace: boolean): string {
	let result = content;
	if (trimWhitespace) {
		result = result.replace(/[ \t]+$/gm, "");
	}
	// 最終行末尾改行は常に保証
	if (result.length === 0 || !result.endsWith("\n")) {
		result += "\n";
	}
	return result;
}
