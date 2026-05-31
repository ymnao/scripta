import { describe, expect, it } from "vitest";
import {
	isStageNotFound,
	MAX_CONFLICT_CONTENT_SIZE,
	validateRefName,
	validateRelativePath,
} from "./git-validators";

describe("validateRelativePath", () => {
	it("rejects empty string", () => {
		expect(() => validateRelativePath("")).toThrow(/must not be empty/);
	});

	it("rejects absolute paths", () => {
		expect(() => validateRelativePath("/etc/passwd")).toThrow(/must be relative/);
		// Windows-style absolute paths are not absolute on POSIX runtime, so we only
		// rely on the cross-platform `isAbsolute()` semantics. POSIX absolute is enough
		// to cover the intended path-traversal guard.
	});

	it("rejects path traversal segments", () => {
		expect(() => validateRelativePath("../secret.md")).toThrow(/must not contain/);
		expect(() => validateRelativePath("subdir/../../etc/passwd")).toThrow(/must not contain/);
		expect(() => validateRelativePath("a/../b")).toThrow(/must not contain/);
	});

	it("rejects control characters", () => {
		expect(() => validateRelativePath("file\x00.md")).toThrow(/control characters/);
		expect(() => validateRelativePath("file\n.md")).toThrow(/control characters/);
		expect(() => validateRelativePath("file\x7f.md")).toThrow(/control characters/);
	});

	it("accepts ordinary relative paths", () => {
		expect(() => validateRelativePath("notes/hello.md")).not.toThrow();
		expect(() => validateRelativePath("日本語ファイル.md")).not.toThrow();
		expect(() => validateRelativePath("a/b/c.md")).not.toThrow();
		// 名前自体に `..` が含まれていても、独立した segment でなければ許可
		// （セグメント単位で `==".."` 比較するため）
		expect(() => validateRelativePath("..backup/file.md")).not.toThrow();
	});
});

describe("validateRefName", () => {
	it("rejects empty name", () => {
		expect(() => validateRefName("")).toThrow(/empty/);
	});

	it("rejects names with prohibited characters", () => {
		const cases = [
			"main..dev",
			"refs~1",
			"refs^1",
			"refs:heads",
			"branch?",
			"branch*",
			"branch[1]",
			"branch\\back",
			"branch@{0}",
		];
		for (const name of cases) {
			expect(() => validateRefName(name)).toThrow(/Invalid ref name/);
		}
	});

	it("rejects names starting with - or .", () => {
		expect(() => validateRefName("-start")).toThrow(/Invalid ref name/);
		expect(() => validateRefName(".hidden")).toThrow(/Invalid ref name/);
	});

	it("rejects names ending with .lock", () => {
		expect(() => validateRefName("branch.lock")).toThrow(/Invalid ref name/);
	});

	it("rejects names with whitespace or control characters", () => {
		expect(() => validateRefName("branch name")).toThrow(/Invalid ref name/);
		expect(() => validateRefName("branch\t")).toThrow(/Invalid ref name/);
		expect(() => validateRefName("branch\x00")).toThrow(/Invalid ref name/);
	});

	it("accepts valid refs", () => {
		expect(() => validateRefName("main")).not.toThrow();
		expect(() => validateRefName("feature/my-branch")).not.toThrow();
		expect(() => validateRefName("origin")).not.toThrow();
		expect(() => validateRefName("v1.0.0")).not.toThrow();
		expect(() => validateRefName("HEAD")).not.toThrow();
	});
});

describe("isStageNotFound", () => {
	it("returns true for known stage-not-found patterns", () => {
		expect(isStageNotFound("path 'foo.md' does not exist")).toBe(true);
		expect(isStageNotFound("git: not at stage 2")).toBe(true);
		expect(isStageNotFound("fatal: invalid object name")).toBe(true);
		expect(isStageNotFound("Not a valid object name :2:foo")).toBe(true);
	});

	it("returns false for unrelated errors", () => {
		expect(isStageNotFound("authentication failed")).toBe(false);
		expect(isStageNotFound("nothing to commit")).toBe(false);
		expect(isStageNotFound("")).toBe(false);
	});
});

describe("MAX_CONFLICT_CONTENT_SIZE", () => {
	it("is 10MB", () => {
		expect(MAX_CONFLICT_CONTENT_SIZE).toBe(10 * 1024 * 1024);
	});
});
