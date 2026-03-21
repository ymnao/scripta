import { describe, expect, it } from "vitest";
import { CodeFenceTracker } from "./code-fence";

describe("CodeFenceTracker", () => {
	it("通常の行はコードブロック外として扱う", () => {
		const tracker = new CodeFenceTracker();
		expect(tracker.processLine("hello")).toBe(false);
		expect(tracker.processLine("world")).toBe(false);
	});

	it("バッククォートフェンスの開始と終了を追跡する", () => {
		const tracker = new CodeFenceTracker();
		expect(tracker.processLine("```")).toBe(true); // 開始行
		expect(tracker.processLine("code here")).toBe(true); // ブロック内
		expect(tracker.processLine("```")).toBe(true); // 終了行
		expect(tracker.processLine("outside")).toBe(false); // ブロック外
	});

	it("チルダフェンスの開始と終了を追跡する", () => {
		const tracker = new CodeFenceTracker();
		expect(tracker.processLine("~~~")).toBe(true);
		expect(tracker.processLine("code")).toBe(true);
		expect(tracker.processLine("~~~")).toBe(true);
		expect(tracker.processLine("outside")).toBe(false);
	});

	it("長いフェンスは同じ長さ以上の閉じフェンスを要求する", () => {
		const tracker = new CodeFenceTracker();
		expect(tracker.processLine("````")).toBe(true); // 4文字で開始
		expect(tracker.processLine("```")).toBe(true); // 3文字では閉じない
		expect(tracker.isInCodeBlock).toBe(true);
		expect(tracker.processLine("````")).toBe(true); // 4文字で閉じる
		expect(tracker.isInCodeBlock).toBe(false);
	});

	it("バッククォートフェンス内のチルダフェンスは無視する", () => {
		const tracker = new CodeFenceTracker();
		tracker.processLine("```");
		expect(tracker.processLine("~~~")).toBe(true); // 閉じとして認識しない
		expect(tracker.isInCodeBlock).toBe(true);
		tracker.processLine("```");
		expect(tracker.isInCodeBlock).toBe(false);
	});

	it("言語指定付きフェンスを認識する", () => {
		const tracker = new CodeFenceTracker();
		expect(tracker.processLine("```javascript")).toBe(true);
		expect(tracker.isInCodeBlock).toBe(true);
		expect(tracker.processLine("```")).toBe(true);
		expect(tracker.isInCodeBlock).toBe(false);
	});
});
