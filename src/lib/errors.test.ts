import { describe, expect, it } from "vitest";
import type { ErrorKind } from "../types/errors";
import { isNetworkError, isTransientError, translateError } from "./errors";

// preload が unmarshal 後に renderer へ渡す形（kind を持つ Error）を模す。
function structuredError(kind: ErrorKind, message = "raw detail"): Error {
	return Object.assign(new Error(message), { kind });
}

describe("translateError", () => {
	const cases: ReadonlyArray<[Exclude<ErrorKind, "UNKNOWN">, string]> = [
		["ENOENT", "ファイルまたはフォルダが見つかりません"],
		["EACCES", "アクセス権限がありません"],
		["EEXIST", "ファイルが既に存在します"],
		["EISDIR", "対象がディレクトリです"],
		["ENOTDIR", "対象がディレクトリではありません"],
		["ENOSPC", "ディスク容量が不足しています"],
		["EROFS", "読み取り専用のファイルシステムです"],
		["EAGAIN", "リソースが一時的に利用できません"],
		["EBUSY", "ファイルが使用中です"],
		["ENAMETOOLONG", "ファイル名が長すぎます"],
		["ENOTEMPTY", "フォルダが空ではありません"],
		["EMFILE", "開いているファイルが多すぎます"],
		["ALREADY_EXISTS", "同名のファイルが既に存在します"],
		["SOURCE_NOT_FOUND", "元のファイルが見つかりません"],
		["TARGET_ALREADY_EXISTS", "移動先に同名のファイルが既に存在します"],
		["NOT_FOUND", "ファイルが見つかりません"],
		["INVALID_PATH", "不正なパスです"],
		["PATH_OUTSIDE_WORKSPACE", "アクセス権限がありません"],
		["GIT_AUTH", "Git 認証に失敗しました"],
		["GIT_CONFLICT", "マージコンフリクトが発生しました"],
		["GIT_NOTHING_TO_COMMIT", "コミットする変更がありません"],
		["GIT_NO_REMOTE_ACCESS", "リモートリポジトリにアクセスできません"],
		["NETWORK", "ネットワークに接続できません"],
		["CONNECTION_REFUSED", "接続が拒否されました"],
		["TIMEOUT", "操作がタイムアウトしました"],
	];

	for (const [kind, message] of cases) {
		it(`translates kind=${kind}`, () => {
			expect(translateError(structuredError(kind))).toBe(message);
		});
	}

	it("falls back with raw detail for UNKNOWN kind", () => {
		expect(translateError(structuredError("UNKNOWN", "boom"))).toBe(
			"予期しないエラーが発生しました。詳細: boom",
		);
	});

	it("falls back with raw message for kind-less Error objects", () => {
		expect(translateError(new Error("Something unexpected happened"))).toBe(
			"予期しないエラーが発生しました。詳細: Something unexpected happened",
		);
	});

	it("falls back with raw message for plain strings", () => {
		expect(translateError("legacy string error")).toBe(
			"予期しないエラーが発生しました。詳細: legacy string error",
		);
	});

	it("handles non-string non-Error values", () => {
		expect(translateError(42)).toBe("予期しないエラーが発生しました。詳細: 42");
	});
});

describe("isTransientError", () => {
	const nonTransient: ReadonlyArray<ErrorKind> = [
		"ALREADY_EXISTS",
		"SOURCE_NOT_FOUND",
		"TARGET_ALREADY_EXISTS",
		"NOT_FOUND",
		"ENOENT",
		"EACCES",
		"EEXIST",
		"EISDIR",
		"ENOTDIR",
		"ENOSPC",
		"EROFS",
		"ENAMETOOLONG",
		"ENOTEMPTY",
		"EMFILE",
		"INVALID_PATH",
		"PATH_OUTSIDE_WORKSPACE",
	];
	const transient: ReadonlyArray<ErrorKind> = [
		"EAGAIN",
		"EBUSY",
		"GIT_AUTH",
		"NETWORK",
		"CONNECTION_REFUSED",
		"TIMEOUT",
		"UNKNOWN",
	];

	for (const kind of nonTransient) {
		it(`returns false for kind=${kind}`, () => {
			expect(isTransientError(structuredError(kind))).toBe(false);
		});
	}

	for (const kind of transient) {
		it(`returns true for kind=${kind}`, () => {
			expect(isTransientError(structuredError(kind))).toBe(true);
		});
	}

	it("returns true for kind-less errors (default retry)", () => {
		expect(isTransientError(new Error("network failure"))).toBe(true);
	});
});

describe("isNetworkError", () => {
	for (const kind of ["NETWORK", "CONNECTION_REFUSED", "TIMEOUT"] as const) {
		it(`returns true for kind=${kind}`, () => {
			expect(isNetworkError(structuredError(kind))).toBe(true);
		});
	}

	for (const kind of [
		"GIT_AUTH",
		"GIT_CONFLICT",
		"GIT_NOTHING_TO_COMMIT",
		"GIT_NO_REMOTE_ACCESS",
		"ENOENT",
	] as const) {
		it(`returns false for kind=${kind}`, () => {
			expect(isNetworkError(structuredError(kind))).toBe(false);
		});
	}

	it("returns false for kind-less errors", () => {
		expect(isNetworkError(new Error("could not resolve host"))).toBe(false);
	});

	it("returns false for non-string non-Error values", () => {
		expect(isNetworkError(42)).toBe(false);
	});
});
