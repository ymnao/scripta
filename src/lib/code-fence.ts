/**
 * 行単位でコードフェンス（``` / ~~~）の状態を追跡するユーティリティ。
 * slide-parser と export の両方で使用される。
 */
export class CodeFenceTracker {
	private inCodeBlock = false;
	private fenceChar = "";
	private fenceLen = 0;

	/**
	 * 1行を処理し、その行がコードブロック内かどうかを返す。
	 * フェンス開始/終了行自体も true を返す。
	 */
	processLine(trimmedLine: string): boolean {
		const fenceMatch = trimmedLine.match(/^(`{3,}|~{3,})/);
		if (fenceMatch) {
			if (!this.inCodeBlock) {
				this.inCodeBlock = true;
				this.fenceChar = fenceMatch[1][0];
				this.fenceLen = fenceMatch[1].length;
				return true;
			}
			if (
				trimmedLine[0] === this.fenceChar &&
				trimmedLine.length >= this.fenceLen &&
				trimmedLine === this.fenceChar.repeat(trimmedLine.length)
			) {
				this.inCodeBlock = false;
				return true;
			}
		}
		return this.inCodeBlock;
	}

	get isInCodeBlock(): boolean {
		return this.inCodeBlock;
	}
}
