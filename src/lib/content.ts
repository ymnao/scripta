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
