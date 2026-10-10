// @vitest-environment node
import * as win32 from "node:path/win32";
import { describe, expect, it } from "vitest";
import { atOrUnderMatcher, type RelPathOps, relComponentsUnderRoot } from "./root-relative-path";

// host OS (POSIX) の relative() は絶対パスを返さないため、isAbsolute ガードは posix path
// では等価変異になる。win32 ops を注入して drive 跨ぎを再現し、そのガードだけを pin する。
const win32Ops: RelPathOps = {
	relative: win32.relative,
	isAbsolute: win32.isAbsolute,
	sep: win32.sep,
};

describe("relComponentsUnderRoot: win32 drive 跨ぎ", () => {
	it("returns null for a path on another drive", () => {
		expect(relComponentsUnderRoot("C:\\ws", "D:\\notes\\a.md", win32Ops)).toBeNull();
	});

	it("returns null for another drive even when a component looks hidden", () => {
		// isAbsolute ガードを外すと `["D:", ".git", "x"]` として root 配下の hidden 扱いになる。
		expect(relComponentsUnderRoot("C:\\ws", "D:\\.git\\x", win32Ops)).toBeNull();
	});

	it("still splits components on the same drive", () => {
		expect(relComponentsUnderRoot("C:\\ws", "C:\\ws\\docs\\a.md", win32Ops)).toEqual([
			"docs",
			"a.md",
		]);
	});
});

describe("atOrUnderMatcher", () => {
	it("matches a path equal to a prefix", () => {
		expect(atOrUnderMatcher(new Set(["/ws/foo"]))("/ws/foo")).toBe(true);
	});

	it("matches a path under a prefix at any depth", () => {
		expect(atOrUnderMatcher(new Set(["/ws/foo"]))("/ws/foo/a/b/c.md")).toBe(true);
	});

	it("does not match /foo against /foobar", () => {
		expect(atOrUnderMatcher(new Set(["/foo"]))("/foobar/a.md")).toBe(false);
	});

	it("does not match a path that is an ancestor of a prefix", () => {
		expect(atOrUnderMatcher(new Set(["/ws/foo"]))("/ws")).toBe(false);
	});

	it("matches against whichever of several prefixes contains the path", () => {
		const prefixes = new Set(["/ws/x.png", "/ws/dir", "/ws/y"]);
		expect(atOrUnderMatcher(prefixes)("/ws/dir/a.md")).toBe(true);
		expect(atOrUnderMatcher(prefixes)("/ws/other/a.md")).toBe(false);
	});

	it("treats a prefix ending with the separator as its own subtree marker", () => {
		expect(atOrUnderMatcher(new Set(["/ws/"]))("/ws/a.md")).toBe(true);
		expect(atOrUnderMatcher(new Set(["/ws/"]))("/ws")).toBe(false);
	});

	it("matches every absolute path against the filesystem root", () => {
		expect(atOrUnderMatcher(new Set(["/"]))("/ws/a.md")).toBe(true);
	});
});
