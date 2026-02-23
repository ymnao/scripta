import { describe, expect, it } from "vitest";
import { isTransientError, translateError } from "./errors";

describe("translateError", () => {
	it("translates Already exists error", () => {
		expect(translateError("Already exists: /path/to/file")).toBe("同名のファイルが既に存在します");
	});

	it("translates Source not found error", () => {
		expect(translateError("Source not found: /path/to/file")).toBe("元のファイルが見つかりません");
	});

	it("translates Target already exists error", () => {
		expect(translateError("Target already exists: /path/to/file")).toBe(
			"移動先に同名のファイルが既に存在します",
		);
	});

	it("translates Not found error", () => {
		expect(translateError("Not found: /path/to/file")).toBe("ファイルが見つかりません");
	});

	it("translates os error 2", () => {
		expect(translateError("No such file or directory (os error 2)")).toBe(
			"ファイルまたはフォルダが見つかりません",
		);
	});

	it("translates os error 13", () => {
		expect(translateError("Permission denied (os error 13)")).toBe("アクセス権限がありません");
	});

	it("translates os error 17", () => {
		expect(translateError("File exists (os error 17)")).toBe("ファイルが既に存在します");
	});

	it("translates os error 28", () => {
		expect(translateError("No space left on device (os error 28)")).toBe(
			"ディスク容量が不足しています",
		);
	});

	it("translates os error 30", () => {
		expect(translateError("Read-only file system (os error 30)")).toBe(
			"読み取り専用のファイルシステムです",
		);
	});

	it("falls back with raw message for unknown errors", () => {
		expect(translateError("Something unexpected happened")).toBe(
			"エラーが発生しました: Something unexpected happened",
		);
	});

	it("handles Error objects", () => {
		expect(translateError(new Error("Not found: /path"))).toBe("ファイルが見つかりません");
	});

	it("handles non-string non-Error values", () => {
		expect(translateError(42)).toBe("エラーが発生しました: 42");
	});
});

describe("isTransientError", () => {
	it("returns false for Already exists error", () => {
		expect(isTransientError("Already exists: /path")).toBe(false);
	});

	it("returns false for Source not found error", () => {
		expect(isTransientError("Source not found: /path")).toBe(false);
	});

	it("returns false for Target already exists error", () => {
		expect(isTransientError("Target already exists: /path")).toBe(false);
	});

	it("returns false for Not found error", () => {
		expect(isTransientError("Not found: /path")).toBe(false);
	});

	it("returns false for os error 2", () => {
		expect(isTransientError("No such file (os error 2)")).toBe(false);
	});

	it("returns false for os error 13", () => {
		expect(isTransientError("Permission denied (os error 13)")).toBe(false);
	});

	it("returns false for os error 28", () => {
		expect(isTransientError("No space (os error 28)")).toBe(false);
	});

	it("returns true for unknown/transient errors", () => {
		expect(isTransientError("Connection timed out")).toBe(true);
	});

	it("returns true for generic Error objects", () => {
		expect(isTransientError(new Error("network failure"))).toBe(true);
	});
});
