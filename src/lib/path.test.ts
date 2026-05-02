import { describe, expect, it } from "vitest";
import {
	addTrailingSep,
	basename,
	createNewTabPath,
	dirname,
	isNewTabPath,
	joinPath,
	replaceName,
	replacePrefix,
} from "./path";

describe("dirname", () => {
	it("returns parent directory for a file path", () => {
		expect(dirname("/workspace/hello.md")).toBe("/workspace");
	});

	it("returns separator for root-level file", () => {
		expect(dirname("/file.md")).toBe("/");
	});

	it("returns '.' when no separator is present", () => {
		expect(dirname("file.md")).toBe(".");
	});

	it("handles nested paths", () => {
		expect(dirname("/a/b/c/d.md")).toBe("/a/b/c");
	});

	it("handles backslash separators", () => {
		expect(dirname("C:\\Users\\docs\\file.md")).toBe("C:\\Users\\docs");
	});

	it("returns drive root for file at drive root", () => {
		expect(dirname("C:\\file.md")).toBe("C:\\");
	});

	it("returns drive root for single directory at root", () => {
		expect(dirname("C:\\Users")).toBe("C:\\");
	});

	it("uses first-found separator for mixed paths", () => {
		// getSep picks '\' (first match), so lastIndexOf('\') stops at 'C:\'
		// Mixed separators don't occur in practice (Tauri uses consistent separators)
		expect(dirname("C:\\Users/docs/file.md")).toBe("C:\\");
	});
});

describe("joinPath", () => {
	it("returns name when base is empty", () => {
		expect(joinPath("", "file.md")).toBe("file.md");
	});

	it("joins base and name with separator", () => {
		expect(joinPath("/workspace", "file.md")).toBe("/workspace/file.md");
	});

	it("does not add double separator when base has trailing sep", () => {
		expect(joinPath("/workspace/", "file.md")).toBe("/workspace/file.md");
	});

	it("handles backslash paths", () => {
		expect(joinPath("C:\\Users\\docs", "file.md")).toBe("C:\\Users\\docs\\file.md");
	});

	it("handles base with trailing backslash", () => {
		expect(joinPath("C:\\Users\\", "file.md")).toBe("C:\\Users\\file.md");
	});
});

describe("replaceName", () => {
	it("replaces the last segment of a path", () => {
		expect(replaceName("/workspace/old.md", "new.md")).toBe("/workspace/new.md");
	});

	it("returns just the new name when there is no separator", () => {
		expect(replaceName("old.md", "new.md")).toBe("new.md");
	});

	it("handles backslash paths", () => {
		expect(replaceName("C:\\docs\\old.md", "new.md")).toBe("C:\\docs\\new.md");
	});
});

describe("basename", () => {
	it("returns the last segment of a Unix path", () => {
		expect(basename("/workspace/hello.md")).toBe("hello.md");
	});

	it("returns the last segment of a Windows path", () => {
		expect(basename("C:\\Users\\docs\\file.md")).toBe("file.md");
	});

	it("returns the string itself when no separator is present", () => {
		expect(basename("file.md")).toBe("file.md");
	});

	it("handles root-level file", () => {
		expect(basename("/file.md")).toBe("file.md");
	});

	it("handles mixed separators (uses first found)", () => {
		expect(basename("/workspace\\sub/file.md")).toBe("file.md");
	});
});

describe("addTrailingSep", () => {
	it("adds a trailing separator when missing", () => {
		expect(addTrailingSep("/workspace")).toBe("/workspace/");
	});

	it("does not add when already present", () => {
		expect(addTrailingSep("/workspace/")).toBe("/workspace/");
	});

	it("handles backslash paths", () => {
		expect(addTrailingSep("C:\\docs")).toBe("C:\\docs\\");
	});
});

describe("replacePrefix", () => {
	it("replaces prefix in a child path", () => {
		expect(replacePrefix("/old/dir/file.md", "/old/dir", "/new/dir")).toBe("/new/dir/file.md");
	});

	it("returns path unchanged when prefix does not match", () => {
		expect(replacePrefix("/other/file.md", "/old/dir", "/new/dir")).toBe("/other/file.md");
	});

	it("handles exact match (path === oldPrefix)", () => {
		expect(replacePrefix("/old/dir", "/old/dir", "/new/dir")).toBe("/new/dir");
	});

	it("handles deeply nested children", () => {
		expect(replacePrefix("/a/b/c/d.md", "/a/b", "/x/y")).toBe("/x/y/c/d.md");
	});

	it("does not match partial directory names", () => {
		expect(replacePrefix("/workspace-old/file.md", "/workspace", "/new")).toBe(
			"/workspace-old/file.md",
		);
	});

	it("handles Windows backslash paths", () => {
		expect(replacePrefix("C:\\old\\dir\\file.md", "C:\\old\\dir", "C:\\new\\dir")).toBe(
			"C:\\new\\dir\\file.md",
		);
	});
});

describe("isNewTabPath", () => {
	it("returns true for newtab:// paths", () => {
		expect(isNewTabPath("newtab://1")).toBe(true);
		expect(isNewTabPath("newtab://42")).toBe(true);
	});

	it("returns false for regular file paths", () => {
		expect(isNewTabPath("/workspace/file.md")).toBe(false);
		expect(isNewTabPath("file.md")).toBe(false);
	});
});

describe("createNewTabPath", () => {
	it("creates a newtab:// path with the given id", () => {
		expect(createNewTabPath(1)).toBe("newtab://1");
		expect(createNewTabPath(99)).toBe("newtab://99");
	});
});
