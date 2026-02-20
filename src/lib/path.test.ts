import { describe, expect, it } from "vitest";
import { addTrailingSep, dirname, joinPath, replaceName, replacePrefix } from "./path";

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
});

describe("joinPath", () => {
	it("joins base and name with separator", () => {
		expect(joinPath("/workspace", "file.md")).toBe("/workspace/file.md");
	});

	it("does not add double separator when base has trailing sep", () => {
		expect(joinPath("/workspace/", "file.md")).toBe("/workspace/file.md");
	});

	it("handles backslash paths", () => {
		expect(joinPath("C:\\Users\\docs", "file.md")).toBe("C:\\Users\\docs\\file.md");
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
});
