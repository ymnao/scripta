// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { clearWorkspaceRoots, registerWorkspaceRoot } from "../utils/path-guard";
import {
	__testing,
	cancelSearchForWindow,
	cancelWikilinkScanForWindow,
	extractWikilinks,
	fuzzyMatch,
	isPathTraversal,
} from "./search";

const TEST_WIN = 1;
const { searchFilesImpl, searchFilenamesImpl, scanUnresolvedWikilinksImpl } = __testing;

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

	it("cancels older wikilink scan when a newer scan starts on the same window", async () => {
		// searchFilesImpl と同じ意図: workspace が大きい状態で連続 scan を投げると
		// main 側の I/O が積み上がる。後発が sync に gen を bump、先発は readFile ループ
		// 直前の isStale check で bail することを確認する。
		for (let i = 0; i < 10; i++) {
			await writeFile(join(workspaceDir, `f${i}.md`), "[[missing]]");
		}
		const [r1, r2] = await Promise.all([
			scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir),
			scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir),
		]);
		expect(r1).toEqual([]);
		expect(r2).toHaveLength(1);
		expect(r2[0].pageName).toBe("missing");
	});

	it("cancelWikilinkScanForWindow stops in-flight wikilink scan", async () => {
		// panel unmount / workspace 切替で renderer から `wikilink:cancel` が送られる。
		// 後発の scan が来なくても先発が isStale で bail することを確認する。
		for (let i = 0; i < 10; i++) {
			await writeFile(join(workspaceDir, `f${i}.md`), "[[missing]]");
		}
		const promise = scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		cancelWikilinkScanForWindow(TEST_WIN);
		const result = await promise;
		expect(result).toEqual([]);
	});

	it("cancelSearchForWindow does NOT cancel in-flight wikilink scan", async () => {
		// regression guard: 共通化していた頃は SearchPanel cleanup 由来の
		// `search:cancel` が wikilink scan も巻き込んで `[]` 化していた。逆方向の
		// クロスキャンセルが起きないことを確認する。
		for (let i = 0; i < 10; i++) {
			await writeFile(join(workspaceDir, `f${i}.md`), "[[missing]]");
		}
		const promise = scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		cancelSearchForWindow(TEST_WIN);
		const result = await promise;
		expect(result).toHaveLength(1);
		expect(result[0].pageName).toBe("missing");
	});

	it("cancelWikilinkScanForWindow does NOT cancel in-flight full-text search", async () => {
		// regression guard: UnresolvedLinksPanel の cleanup で SearchPanel の
		// 検索結果を空にしてしまう regression を防ぐ。検索が走り切ることを確認する。
		for (let i = 0; i < 10; i++) {
			await writeFile(join(workspaceDir, `f${i}.md`), "hello world");
		}
		const promise = searchFilesImpl(TEST_WIN, workspaceDir, "hello");
		cancelWikilinkScanForWindow(TEST_WIN);
		const result = await promise;
		expect(result).toHaveLength(10);
	});
});

describe("searchFilesImpl", () => {
	it("finds matches across multiple files", async () => {
		await writeFile(join(workspaceDir, "a.md"), "Hello World\nfoo bar\nhello again");
		await writeFile(join(workspaceDir, "b.md"), "no match here");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "hello");
		expect(out).toHaveLength(2);
		expect(out[0].lineNumber).toBe(1);
		expect(out[0].matchStart).toBe(0);
		expect(out[0].matchEnd).toBe(5);
		expect(out[0].lineContent).toBe("Hello World");
		expect(out[1].lineNumber).toBe(3);
		expect(out[1].lineContent).toBe("hello again");
	});

	it("is case-insensitive by default", async () => {
		await writeFile(join(workspaceDir, "a.md"), "Hello HELLO hElLo");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "hello");
		expect(out).toHaveLength(3);
		expect(out.map((r) => r.matchStart)).toEqual([0, 6, 12]);
	});

	it("is case-sensitive when caseSensitive=true", async () => {
		await writeFile(join(workspaceDir, "a.md"), "Hello HELLO hello");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "Hello", true);
		expect(out).toHaveLength(1);
		expect(out[0].matchStart).toBe(0);
		expect(out[0].matchEnd).toBe(5);
	});

	it("keeps offsets aligned when toLowerCase changes length (Turkish İ)", async () => {
		// "İ" (U+0130, 1 UTF-16 unit) → "i̇" (2 UTF-16 units)
		// 元の line "İhello" の "hello" は UTF-16 offset 1〜6 にある。
		// lower("İhello") = "i̇hello"、ここで "hello" は offset 2〜7。
		// lowerToOrig 経由で 1〜6 に戻ることを確認する。
		await writeFile(join(workspaceDir, "a.md"), "İhello");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "hello");
		expect(out).toHaveLength(1);
		expect(out[0].matchStart).toBe(1);
		expect(out[0].matchEnd).toBe(6);
		expect(out[0].lineContent).toBe("İhello");
	});

	it("returns correct UTF-16 offsets across multibyte chars", async () => {
		// "あいう hello world" → "hello" は UTF-16 offset 4〜9（あ/い/う + space + hello）
		await writeFile(join(workspaceDir, "a.md"), "あいう hello world");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "hello");
		expect(out).toHaveLength(1);
		expect(out[0].matchStart).toBe(4);
		expect(out[0].matchEnd).toBe(9);
	});

	it("returns correct UTF-16 offsets for surrogate pairs", async () => {
		// "😀hello world" → 😀 は 2 UTF-16 unit、"hello" は offset 2〜7
		await writeFile(join(workspaceDir, "a.md"), "😀hello world");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "hello");
		expect(out).toHaveLength(1);
		expect(out[0].matchStart).toBe(2);
		expect(out[0].matchEnd).toBe(7);
	});

	it("accumulates UTF-16 units for multiple surrogate pairs", async () => {
		// "🎉🎊test" → 🎉🎊 で 4 UTF-16 unit、"test" は offset 4〜8
		await writeFile(join(workspaceDir, "a.md"), "🎉🎊test");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "test");
		expect(out).toHaveLength(1);
		expect(out[0].matchStart).toBe(4);
		expect(out[0].matchEnd).toBe(8);
	});

	it("returns [] for empty query", async () => {
		await writeFile(join(workspaceDir, "a.md"), "hello world");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "");
		expect(out).toEqual([]);
	});

	it("returns [] when no match", async () => {
		await writeFile(join(workspaceDir, "a.md"), "hello world");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "xyz");
		expect(out).toEqual([]);
	});

	it("excludes hidden directories", async () => {
		await mkdir(join(workspaceDir, ".hidden"));
		await writeFile(join(workspaceDir, ".hidden/secret.md"), "match here");
		await writeFile(join(workspaceDir, "visible.md"), "match here");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "match");
		expect(out).toHaveLength(1);
		expect(out[0].filePath).toContain("visible.md");
	});

	it("includes only .md files", async () => {
		await writeFile(join(workspaceDir, "test.md"), "match");
		await writeFile(join(workspaceDir, "test.txt"), "match");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "match");
		expect(out).toHaveLength(1);
		expect(out[0].filePath).toContain("test.md");
	});

	it("recurses into subdirectories", async () => {
		await mkdir(join(workspaceDir, "sub"));
		await writeFile(join(workspaceDir, "sub/nested.md"), "deep match");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "deep");
		expect(out).toHaveLength(1);
		expect(out[0].filePath).toContain("nested.md");
	});

	it("captures all matches per single line (multi-match while-loop)", async () => {
		// "ababab" 内に "ab" が 3 件、非重複で抽出される（pos = lowerEnd で進める）
		await writeFile(join(workspaceDir, "a.md"), "ababab");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "ab");
		expect(out).toHaveLength(3);
		expect(out.map((r) => r.matchStart)).toEqual([0, 2, 4]);
	});

	it("returns input-base path even when workspace is reached via symlink", async () => {
		// Stage 2 で確立した canonical / input 分離が searchFilesImpl にも効いていることを確認。
		// symlink 経由のワークスペースでも、戻り値の filePath は input-base（symlink 側のパス）。
		const realDir = await mkdtemp(join(tmpdir(), "scripta-search-real-"));
		const linkDir = await mkdtemp(join(tmpdir(), "scripta-search-link-"));
		// linkDir 自体は mkdtemp で作られた実ディレクトリなので、その中に link を張る。
		const symlinkPath = join(linkDir, "ws-link");
		try {
			await writeFile(join(realDir, "note.md"), "hello world");
			await symlink(realDir, symlinkPath, "dir");
			clearWorkspaceRoots();
			registerWorkspaceRoot(TEST_WIN, symlinkPath);
			const out = await searchFilesImpl(TEST_WIN, symlinkPath, "hello");
			expect(out).toHaveLength(1);
			// filePath は input-base = symlinkPath 配下を指すべき（canonical = realDir 配下では「ない」）
			expect(out[0].filePath.startsWith(symlinkPath)).toBe(true);
			expect(out[0].filePath.startsWith(realDir)).toBe(false);
		} finally {
			await rm(realDir, { recursive: true, force: true });
			await rm(linkDir, { recursive: true, force: true });
		}
	});

	it("rejects unauthorized workspace path", async () => {
		await expect(searchFilesImpl(999 /* not registered */, workspaceDir, "hello")).rejects.toThrow(
			/Permission denied/,
		);
	});

	it("rejects unauthorized workspace even with empty query (auth before short-circuit)", async () => {
		// 早期 return が path-guard より前にあると、未認可 renderer が "" で
		// 叩いて [] を取得できて IPC 認可挙動が崩れる。空クエリでも auth は必須。
		await expect(searchFilesImpl(999 /* not registered */, workspaceDir, "")).rejects.toThrow(
			/Permission denied/,
		);
	});

	it("cancels older search when a newer search starts on the same window", async () => {
		// 連続入力で古い search が止まらないと main の I/O が積み上がる。
		// per-window 世代カウンタで先発の検索は早期 return する。
		// 並走を確実にするため複数ファイルを置いて、collectMdFilesForWorkspace が
		// 完了したタイミングで gen 比較が確実に偽になるようにする。
		for (let i = 0; i < 10; i++) {
			await writeFile(join(workspaceDir, `f${i}.md`), "hello world");
		}
		const [r1, r2] = await Promise.all([
			searchFilesImpl(TEST_WIN, workspaceDir, "hello"),
			searchFilesImpl(TEST_WIN, workspaceDir, "hello"),
		]);
		// 後発の searchFilesImpl が sync に gen を bump するので、先発は
		// collectMdFilesForWorkspace 直後の isStale check で必ず bail する。
		expect(r1).toEqual([]);
		expect(r2).toHaveLength(10);
	});

	it("cancelSearchForWindow stops in-flight search even when no newer search starts", async () => {
		// 「新しい検索で古い検索を止める」だけだと、ユーザーがクエリを消したり
		// panel を閉じたりした場合に main の I/O が走り切ってしまう。
		// 明示的な cancelSearchForWindow が gen を bump し、
		// 先発が isStale で bail することを確認する。
		for (let i = 0; i < 10; i++) {
			await writeFile(join(workspaceDir, `f${i}.md`), "hello world");
		}
		// searchFilesImpl は sync に gen を 1 に set してから collectMdFiles を await する。
		// その後同期的に cancelSearchForWindow を呼んで gen を 2 に bump すれば、
		// resumption 時の isStale check で先発は bail する。
		const promise = searchFilesImpl(TEST_WIN, workspaceDir, "hello");
		cancelSearchForWindow(TEST_WIN);
		const result = await promise;
		expect(result).toEqual([]);
	});

	it("cancelSearchForWindow is a no-op when no search has run for the window", async () => {
		// 未登録 window への cancel は静かに no-op になる（Map に entry がない）。
		// renderer 側 useEffect cleanup が空打ちで送ってきても問題ないこと。
		expect(() => cancelSearchForWindow(424242)).not.toThrow();
	});
});
