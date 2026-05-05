// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { clearWorkspaceRoots, registerWorkspaceRoot } from "../utils/path-guard";
import { __testing, extractWikilinks, fuzzyMatch, isPathTraversal } from "./search";

const TEST_WIN = 1;
const { searchFilenamesImpl, scanUnresolvedWikilinksImpl } = __testing;

let workspaceDir = "";

beforeEach(async () => {
	clearWorkspaceRoots();
	workspaceDir = await mkdtemp(join(tmpdir(), "scripta-search-test-"));
	registerWorkspaceRoot(TEST_WIN, workspaceDir);
});

afterEach(async () => {
	clearWorkspaceRoots();
	await rm(workspaceDir, { recursive: true, force: true });
});

describe("fuzzyMatch", () => {
	it("matches when query chars appear in order", () => {
		expect(fuzzyMatch("hw", "hello-world.md")).toBe(true);
	});

	it("returns true for empty query", () => {
		expect(fuzzyMatch("", "anything")).toBe(true);
	});

	it("returns false when chars missing", () => {
		expect(fuzzyMatch("xyz", "hello")).toBe(false);
	});

	it("is case insensitive", () => {
		expect(fuzzyMatch("HW", "hello-world.md")).toBe(true);
		expect(fuzzyMatch("hw", "Hello-World.md")).toBe(true);
	});
});

describe("isPathTraversal", () => {
	it("rejects forward slash", () => {
		expect(isPathTraversal("path/to/file")).toBe(true);
	});

	it("rejects backslash", () => {
		expect(isPathTraversal("path\\to\\file")).toBe(true);
	});

	it("rejects single dot", () => {
		expect(isPathTraversal(".")).toBe(true);
	});

	it("rejects double dot anywhere", () => {
		expect(isPathTraversal("..")).toBe(true);
		expect(isPathTraversal("..secret")).toBe(true);
	});

	it("accepts normal page names", () => {
		expect(isPathTraversal("normal")).toBe(false);
		expect(isPathTraversal("page-name")).toBe(false);
		expect(isPathTraversal("日本語ページ")).toBe(false);
	});
});

describe("extractWikilinks", () => {
	it("extracts a single wikilink with 1-based UTF-8 byteOffset", () => {
		// "See " は 4 byte → `[[` の byteOffset = 5
		const out = [...extractWikilinks("See [[target]] here")];
		expect(out).toEqual([{ inner: "target", byteOffset: 5 }]);
	});

	it("computes UTF-8 byteOffset across multibyte chars", () => {
		// "あ" は UTF-8 で 3 byte → `[[` の byteOffset = 4
		const out = [...extractWikilinks("あ[[x]]")];
		expect(out).toEqual([{ inner: "x", byteOffset: 4 }]);
	});

	it("extracts multiple wikilinks on the same line", () => {
		const out = [...extractWikilinks("[[alpha]] and [[beta]]")];
		expect(out.map((x) => x.inner)).toEqual(["alpha", "beta"]);
	});

	it("skips empty inner", () => {
		const out = [...extractWikilinks("[[]] and [[valid]]")];
		expect(out.map((x) => x.inner)).toEqual(["valid"]);
	});

	it("returns empty when no wikilink", () => {
		const out = [...extractWikilinks("plain text")];
		expect(out).toEqual([]);
	});

	it("returns empty when unclosed", () => {
		const out = [...extractWikilinks("text [[unclosed")];
		expect(out).toEqual([]);
	});
});

describe("searchFilenamesImpl", () => {
	it("returns fuzzy-matched .md files", async () => {
		await writeFile(join(workspaceDir, "hello-world.md"), "");
		await writeFile(join(workspaceDir, "another.md"), "");
		const out = await searchFilenamesImpl(TEST_WIN, workspaceDir, "hw");
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("hello-world.md");
	});

	it("returns all .md files when query is empty", async () => {
		await writeFile(join(workspaceDir, "a.md"), "");
		await writeFile(join(workspaceDir, "b.md"), "");
		const out = await searchFilenamesImpl(TEST_WIN, workspaceDir, "");
		expect(out).toHaveLength(2);
	});

	it("returns empty when no match", async () => {
		await writeFile(join(workspaceDir, "hello.md"), "");
		const out = await searchFilenamesImpl(TEST_WIN, workspaceDir, "xyz");
		expect(out).toEqual([]);
	});

	it("excludes hidden directories", async () => {
		await mkdir(join(workspaceDir, ".hidden"));
		await writeFile(join(workspaceDir, ".hidden/secret.md"), "");
		await writeFile(join(workspaceDir, "visible.md"), "");
		const out = await searchFilenamesImpl(TEST_WIN, workspaceDir, "");
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("visible.md");
	});

	it("includes only .md files", async () => {
		await writeFile(join(workspaceDir, "test.md"), "");
		await writeFile(join(workspaceDir, "test.txt"), "");
		const out = await searchFilenamesImpl(TEST_WIN, workspaceDir, "");
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("test.md");
	});

	it("recurses into subdirectories", async () => {
		await mkdir(join(workspaceDir, "sub"));
		await writeFile(join(workspaceDir, "sub/nested.md"), "");
		const out = await searchFilenamesImpl(TEST_WIN, workspaceDir, "");
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("nested.md");
	});

	it("rejects unauthorized workspace path", async () => {
		await expect(searchFilenamesImpl(999 /* not registered */, workspaceDir, "")).rejects.toThrow(
			/Permission denied/,
		);
	});
});

describe("scanUnresolvedWikilinksImpl", () => {
	it("detects basic unresolved link", async () => {
		await writeFile(join(workspaceDir, "note.md"), "See [[missing-page]] for details");
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].pageName).toBe("missing-page");
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(1);
	});

	it("filters out existing files", async () => {
		await writeFile(join(workspaceDir, "existing.md"), "# Existing");
		await writeFile(join(workspaceDir, "note.md"), "Link to [[existing]] and [[missing]]");
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].pageName).toBe("missing");
	});

	it("excludes content inside fenced code block (```)", async () => {
		await writeFile(join(workspaceDir, "note.md"), "```\n[[in-code]]\n```\n[[outside-code]]");
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].pageName).toBe("outside-code");
	});

	it("excludes content inside fenced code block (~~~)", async () => {
		await writeFile(join(workspaceDir, "note.md"), "~~~\n[[in-code]]\n~~~\n[[outside]]");
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].pageName).toBe("outside");
	});

	it("parses pipe alias (uses left side)", async () => {
		await writeFile(join(workspaceDir, "note.md"), "See [[target|display text]] here");
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].pageName).toBe("target");
	});

	it("rejects path traversal in page names", async () => {
		await writeFile(
			join(workspaceDir, "note.md"),
			"[[../secret]] [[./local]] [[path/to/file]] [[normal]]",
		);
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].pageName).toBe("normal");
	});

	it("handles Japanese filenames with NFC normalization", async () => {
		await writeFile(join(workspaceDir, "メモ.md"), "# メモ");
		await writeFile(join(workspaceDir, "note.md"), "[[メモ]] and [[未作成ページ]]");
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].pageName).toBe("未作成ページ");
	});

	it("captures ±3 lines of context", async () => {
		await writeFile(
			join(workspaceDir, "note.md"),
			"line1\nline2\nline3\nline4 [[missing]] here\nline5\nline6\nline7",
		);
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		const ref = out[0].references[0];
		expect(ref.lineNumber).toBe(4);
		expect(ref.contextBefore).toEqual(["line1", "line2", "line3"]);
		expect(ref.contextAfter).toEqual(["line5", "line6", "line7"]);
	});

	it("aggregates multiple references to the same page", async () => {
		await writeFile(join(workspaceDir, "a.md"), "See [[missing]]");
		await writeFile(join(workspaceDir, "b.md"), "Also [[missing]]");
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].pageName).toBe("missing");
		expect(out[0].references).toHaveLength(2);
	});

	it("ignores empty wikilinks", async () => {
		await writeFile(join(workspaceDir, "note.md"), "[[]] and [[valid]]");
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].pageName).toBe("valid");
	});

	it("strips .md suffix when matching against existing files", async () => {
		await writeFile(join(workspaceDir, "existing.md"), "# Existing");
		await writeFile(join(workspaceDir, "note.md"), "[[existing.md]]");
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toEqual([]);
	});

	it("returns multiple unresolved links sorted by page name", async () => {
		await writeFile(join(workspaceDir, "note.md"), "[[beta]] and [[alpha]]");
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(2);
		expect(out[0].pageName).toBe("alpha");
		expect(out[1].pageName).toBe("beta");
	});

	it("byteOffset is 1-based UTF-8 byte position", async () => {
		// "あ" は UTF-8 で 3 bytes。`あ[[x]]` の `[[` は char index 1、UTF-8 byte 3 → byteOffset = 4
		await writeFile(join(workspaceDir, "note.md"), "あ[[x]]");
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].references[0].byteOffset).toBe(4);
	});

	it("rejects unauthorized workspace path", async () => {
		await expect(
			scanUnresolvedWikilinksImpl(999 /* not registered */, workspaceDir),
		).rejects.toThrow(/Permission denied/);
	});
});
