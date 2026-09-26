// @vitest-environment node
import * as win32 from "node:path/win32";
import { describe, expect, it } from "vitest";
import { type RelPathOps, relComponentsUnderRoot } from "./root-relative-path";

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
