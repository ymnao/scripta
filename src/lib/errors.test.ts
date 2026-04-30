import { describe, expect, it } from "vitest";
import { isNetworkError, isTransientError, translateError } from "./errors";

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

	it("translates os error 11", () => {
		expect(translateError("Resource temporarily unavailable (os error 11)")).toBe(
			"リソースが一時的に利用できません",
		);
	});

	it("translates os error 16", () => {
		expect(translateError("Device or resource busy (os error 16)")).toBe("ファイルが使用中です");
	});

	it("translates os error 35", () => {
		expect(translateError("Resource temporarily unavailable (os error 35)")).toBe(
			"リソースが一時的に利用できません",
		);
	});

	it("translates os error 36", () => {
		expect(translateError("Operation now in progress (os error 36)")).toBe("操作の進行中です");
	});

	it("translates os error 63", () => {
		expect(translateError("File name too long (os error 63)")).toBe("ファイル名が長すぎます");
	});

	it("translates os error 66", () => {
		expect(translateError("Directory not empty (os error 66)")).toBe("フォルダが空ではありません");
	});

	it("translates timed out error", () => {
		expect(translateError("Operation timed out")).toBe("操作がタイムアウトしました");
	});

	it("translates timeout error", () => {
		expect(translateError("Connection timeout")).toBe("操作がタイムアウトしました");
	});

	it("translates too many open files error", () => {
		expect(translateError("Too many open files")).toBe("開いているファイルが多すぎます");
	});

	it("translates connection refused error", () => {
		expect(translateError("Connection refused")).toBe("接続が拒否されました");
	});

	it("translates network is unreachable error", () => {
		expect(translateError("Network is unreachable")).toBe("ネットワークに接続できません");
	});

	it("falls back with raw message for unknown errors", () => {
		expect(translateError("Something unexpected happened")).toBe(
			"予期しないエラーが発生しました。詳細: Something unexpected happened",
		);
	});

	it("handles Error objects", () => {
		expect(translateError(new Error("Not found: /path"))).toBe("ファイルが見つかりません");
	});

	it("handles non-string non-Error values", () => {
		expect(translateError(42)).toBe("予期しないエラーが発生しました。詳細: 42");
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

	it("returns true for os error 11 (transient)", () => {
		expect(isTransientError("Resource temporarily unavailable (os error 11)")).toBe(true);
	});

	it("returns true for os error 16 (transient)", () => {
		expect(isTransientError("Device or resource busy (os error 16)")).toBe(true);
	});

	it("returns true for os error 35 (transient)", () => {
		expect(isTransientError("Resource temporarily unavailable (os error 35)")).toBe(true);
	});

	it("returns true for os error 36 (transient)", () => {
		expect(isTransientError("Operation now in progress (os error 36)")).toBe(true);
	});

	it("returns false for os error 63 (non-transient)", () => {
		expect(isTransientError("File name too long (os error 63)")).toBe(false);
	});

	it("returns false for os error 66 (non-transient)", () => {
		expect(isTransientError("Directory not empty (os error 66)")).toBe(false);
	});

	it("returns true for unknown/transient errors", () => {
		expect(isTransientError("Connection timed out")).toBe(true);
	});

	it("returns true for generic Error objects", () => {
		expect(isTransientError(new Error("network failure"))).toBe(true);
	});
});

describe("isNetworkError", () => {
	it("detects 'could not resolve host'", () => {
		expect(
			isNetworkError("fatal: unable to access 'https://...': Could not resolve host: github.com"),
		).toBe(true);
	});

	it("detects 'unable to access' with network cause", () => {
		expect(
			isNetworkError(
				"fatal: unable to access 'https://github.com/repo.git/': Failed to connect to github.com port 443",
			),
		).toBe(true);
	});

	it("returns false for 'unable to access' without network cause (e.g. auth)", () => {
		expect(isNetworkError("fatal: unable to access 'https://github.com/repo.git/'")).toBe(false);
	});

	it("returns false for 'unable to access' with HTTP 403", () => {
		expect(
			isNetworkError(
				"fatal: unable to access 'https://github.com/repo.git/': The requested URL returned error: 403",
			),
		).toBe(false);
	});

	it("detects 'connection refused'", () => {
		expect(isNetworkError("fatal: Connection refused")).toBe(true);
	});

	it("detects 'network is unreachable'", () => {
		expect(isNetworkError("fatal: network is unreachable")).toBe(true);
	});

	it("detects 'connection timed out'", () => {
		expect(isNetworkError("Connection timed out")).toBe(true);
	});

	it("detects 'failed to connect'", () => {
		expect(isNetworkError("Failed to connect to github.com port 443")).toBe(true);
	});

	it("returns false for authentication errors", () => {
		expect(isNetworkError("fatal: Authentication failed for 'https://...'")).toBe(false);
	});

	it("returns false for merge conflict errors", () => {
		expect(isNetworkError("CONFLICT (content): Merge conflict in file.md")).toBe(false);
	});

	it("returns false for nothing to commit", () => {
		expect(isNetworkError("nothing to commit, working tree clean")).toBe(false);
	});

	it("handles Error objects", () => {
		expect(isNetworkError(new Error("could not resolve host: example.com"))).toBe(true);
	});

	it("handles non-string non-Error values", () => {
		expect(isNetworkError(42)).toBe(false);
	});
});
