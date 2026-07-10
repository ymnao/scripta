// @vitest-environment node
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { createTempWorkspace, type TempWorkspace } from "../test-utils/temp-workspace";
import { clearWorkspaceRoots, registerWorkspaceRoot } from "../utils/path-guard";
import {
	__testing,
	cancelBacklinkScanForWindow,
	cancelSearchForWindow,
	cancelWikilinkScanForWindow,
	extractWikilinks,
	isPathTraversal,
} from "./search";

const TEST_WIN = 1;
const { searchFilesImpl, searchFilenamesImpl, scanUnresolvedWikilinksImpl, scanBacklinksImpl } =
	__testing;

let workspaceDir = "";
let ws: TempWorkspace;

beforeEach(async () => {
	clearWorkspaceRoots();
	ws = await createTempWorkspace("scripta-search-test-");
	workspaceDir = ws.dir;
	await registerWorkspaceRoot(TEST_WIN, workspaceDir);
});

afterEach(async () => {
	clearWorkspaceRoots();
	await ws.cleanup();
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
		expect(out).toEqual([{ inner: "target", byteOffset: 5, openOffset: 4 }]);
	});

	it("computes UTF-8 byteOffset across multibyte chars", () => {
		// "あ" は UTF-8 で 3 byte → `[[` の byteOffset = 4
		const out = [...extractWikilinks("あ[[x]]")];
		expect(out).toEqual([{ inner: "x", byteOffset: 4, openOffset: 1 }]);
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

	it("excludes node_modules directory (#299)", async () => {
		await mkdir(join(workspaceDir, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(workspaceDir, "node_modules/pkg/README.md"), "");
		await writeFile(join(workspaceDir, "node_modules.md"), "");
		const out = await searchFilenamesImpl(TEST_WIN, workspaceDir, "");
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("node_modules.md");
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

	it("trims leading/trailing whitespace from each reference lineContent (#227)", async () => {
		await writeFile(
			join(workspaceDir, "note.md"),
			"  - list with [[missing]]  \n\t[[missing]] indented\t\n",
		);
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(2);
		expect(out[0].references[0].lineContent).toBe("- list with [[missing]]");
		expect(out[0].references[1].lineContent).toBe("[[missing]] indented");
	});

	it("trims each occurrence independently when [[missing]] appears multiple times on the same line (#241)", async () => {
		// scanBacklinksImpl 側 #241 test と対称: iterateWikilinkOccurrences の
		// per-yield 新規 alloc contract を unresolved consumer 側からも lock する。
		await writeFile(
			join(workspaceDir, "note.md"),
			"  see [[missing]] and [[missing]] in the same line  \n",
		);
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(2);
		expect(out[0].references[0].lineContent).toBe(
			"see [[missing]] and [[missing]] in the same line",
		);
		expect(out[0].references[1].lineContent).toBe(
			"see [[missing]] and [[missing]] in the same line",
		);
		expect(out[0].references[0].byteOffset).not.toBe(out[0].references[1].byteOffset);
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

	it("excludes escaped and inline-code wikilinks (iterateWikilinkOccurrences の effects も unresolved 側で確認)", async () => {
		// 本番リファクタで scanUnresolvedWikilinksImpl も iterateWikilinkOccurrences 経由になり、
		// escape / inline code 除外が unresolved 側にも作用することを ピン留め。
		await writeFile(
			join(workspaceDir, "note.md"),
			"escape \\[[missing]] here\ninline `[[missing]]` code\nreal [[missing]] link",
		);
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].pageName).toBe("missing");
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(3);
	});

	it("excludes wikilinks inside multi-line inline code span (unresolved 側にも同 effect)", async () => {
		// 複数行 inline code span (CommonMark で valid) も unresolved 側で除外される
		// ことを確認する (本番 iterateWikilinkOccurrences の text 全体走査が効くこと)。
		await writeFile(
			join(workspaceDir, "note.md"),
			"in span `start\n[[missing]]\nend` not link\nreal [[missing]] link",
		);
		const out = await scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		expect(out).toHaveLength(1);
		expect(out[0].pageName).toBe("missing");
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(4);
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

describe("scanBacklinksImpl", () => {
	it("returns empty array when no other file references target", async () => {
		await writeFile(join(workspaceDir, "target.md"), "# Target");
		await writeFile(join(workspaceDir, "other.md"), "no link here");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toEqual([]);
	});

	it("groups references by sourceFile and counts each occurrence", async () => {
		await writeFile(join(workspaceDir, "target.md"), "# Target");
		await writeFile(join(workspaceDir, "a.md"), "See [[target]]\nand [[target]] again");
		await writeFile(join(workspaceDir, "b.md"), "Refers to [[target|display]]");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(2);
		expect(out[0].sourceFile).toBe(join(workspaceDir, "a.md"));
		expect(out[0].references).toHaveLength(2);
		expect(out[1].sourceFile).toBe(join(workspaceDir, "b.md"));
		expect(out[1].references).toHaveLength(1);
	});

	it("excludes self-reference (target file linking to itself)", async () => {
		await writeFile(join(workspaceDir, "target.md"), "[[target]] is a self-reference");
		await writeFile(join(workspaceDir, "other.md"), "[[target]]");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].sourceFile).toBe(join(workspaceDir, "other.md"));
	});

	it("returns empty when target file is not .md", async () => {
		await writeFile(join(workspaceDir, "other.md"), "[[target]]");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.txt"));
		expect(out).toEqual([]);
	});

	it("returns empty when target file extension is uppercase .MD (walkMdFiles と同じ小文字限定方針)", async () => {
		await writeFile(join(workspaceDir, "other.md"), "[[Target]]");
		await writeFile(join(workspaceDir, "Target.MD"), "");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "Target.MD"));
		expect(out).toEqual([]);
	});

	it("alias form [[target|display]] matches by target name", async () => {
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(join(workspaceDir, "a.md"), "[[target|My Display]]");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references[0].lineContent).toBe("[[target|My Display]]");
	});

	it("trims leading/trailing whitespace from each reference lineContent (#227)", async () => {
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(
			join(workspaceDir, "src.md"),
			"  - list with [[target]]  \n\t[[target]] indented\t\n",
		);
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(2);
		expect(out[0].references[0].lineContent).toBe("- list with [[target]]");
		expect(out[0].references[1].lineContent).toBe("[[target]] indented");
	});

	it("trims each occurrence independently when [[target]] appears multiple times on the same line (#241)", async () => {
		// iterateWikilinkOccurrences (search.ts) は yield 毎に新規 ref オブジェクトを
		// alloc する設計で、producer-side `line.trim()` (#227) はその「per-yield 新規
		// alloc」前提に依存している。将来 helper が ref を pool/reuse する refactor を
		// 入れると trim 効果が壊れるため、同一行 multi-occurrence の独立性を defensive
		// に lock する (byteOffset が異なる = 別 ref であることも併せて確認)。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(
			join(workspaceDir, "src.md"),
			"  see [[target]] and [[target]] in the same line  \n",
		);
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(2);
		expect(out[0].references[0].lineContent).toBe("see [[target]] and [[target]] in the same line");
		expect(out[0].references[1].lineContent).toBe("see [[target]] and [[target]] in the same line");
		expect(out[0].references[0].byteOffset).not.toBe(out[0].references[1].byteOffset);
	});

	it("ignores wikilinks inside fenced code blocks", async () => {
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(join(workspaceDir, "a.md"), "```\n[[target]]\n```\nbut [[target]] here counts");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(4);
	});

	it("excludes escaped wikilinks (\\[[target]] is not a real link)", async () => {
		// live-preview (src/components/editor/live-preview/wikilinks.ts:78) は
		// `\[[target]]` をリンク扱いしないので、backlink もそれに合わせる。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(join(workspaceDir, "src.md"), "escaped \\[[target]] here\n[[target]] real");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(2);
	});

	it("excludes wikilinks inside inline code", async () => {
		// live-preview の InlineCode 範囲 (math.ts:collectCodeRanges 経由) と同じく
		// `` `[[target]]` `` はリンク扱いされないので backlink からも除外。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(
			join(workspaceDir, "src.md"),
			"in code `[[target]]` not a link\n[[target]] real link",
		);
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(2);
	});

	it("excludes wikilinks inside double-backtick inline code (``code``)", async () => {
		// CommonMark の N 連続 backtick code span: ``code`` も inline code として除外する。
		// 旧簡易判定 (odd count) では openOffset 前の backtick が 2 個で偶数になり漏れていた。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(
			join(workspaceDir, "src.md"),
			"see ``[[target]]`` not link\nreal [[target]] link",
		);
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(2);
	});

	it("includes wikilinks when an opening backtick has no matching close (CommonMark: literal)", async () => {
		// CommonMark 仕様: 開きバックティックに対応する閉じが見つからない場合、
		// バックティックは単なるリテラル → 後続の `[[target]]` はリンク扱い。
		// 旧簡易判定 (odd count) では false negative になっていたケース。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(join(workspaceDir, "src.md"), "lone ` then [[target]] still real");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(1);
	});

	it("excludes wikilinks inside multi-line inline code span (CommonMark allows backticks across lines)", async () => {
		// CommonMark の inline code span は改行を跨げる。live-preview の lezer InlineCode も
		// 同様に複数行 1 ノードで扱うので、main / mock もそれに合わせる。
		// line scope の判定だと、開きと閉じが別行にあるケースで false positive になる。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(
			join(workspaceDir, "src.md"),
			"in span `start\n[[target]]\nend` not link\nreal [[target]] link",
		);
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(4);
	});

	it("treats backslash-prefixed backtick as a valid closing delimiter (CommonMark literal backslash)", async () => {
		// CommonMark: code span 内の `\` は literal、閉じ backtick の前に `\` があっても
		// 閉じとして valid。`foo \` で code span が閉じ、後続の [[target]] は code span 外
		// (live-preview の lezer InlineCode と一致)。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(join(workspaceDir, "src.md"), "`foo \\` [[target]] bar`");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(1);
	});

	it("does not open a code span from the 2nd backtick of an escaped run (\\``)", async () => {
		// `\\\`\\\`` のように escape された backtick の直後に別の backtick が続く場合、
		// run 全体が delimiter にならない (Lezer / live-preview も同様)。
		// i++ だけだと 2 文字目を open として誤開始し、後続の [[target]] を code span 内に
		// 巻き込む regression があった。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(join(workspaceDir, "src.md"), "\\`` [[target]] `");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(1);
	});

	it("does not let tilde-fenced backticks pair with outside backticks", async () => {
		// ~~~ fenced code block 内の `` ` `` が、外側の単独 `` ` `` と peer になって
		// 外側 [[target]] を inline code 内と誤判定するのを防ぐ (fenced 範囲 mask が効くこと)。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(join(workspaceDir, "src.md"), "~~~\n`\n~~~\n[[target]]\n`");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(4);
	});

	it("fenced opener of ~~~ is not closed by ``` (CommonMark: same fence char required)", async () => {
		// ~~~ で開いた fence は ``` では閉じない。旧実装は単純 toggle で
		// closing を誤判定 → 3 行目以降が fenced 外扱いになり [[target]] が含まれていた。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(join(workspaceDir, "src.md"), "~~~\n```\n[[target]]\n~~~");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toEqual([]);
	});

	it("fenced opener of length 4 is not closed by length-3 marker (CommonMark: closer length >= opener)", async () => {
		// 4 連続 backtick の opener は 3 連続では閉じない。旧実装は startsWith("```") で
		// 同一視 → 中間の ``` を close と誤判定し後続 [[target]] を fenced 外扱いしていた。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(join(workspaceDir, "src.md"), "````\ncode\n```\n[[target]]\n````");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toEqual([]);
	});

	it("closer with trailing info text does not close the fence (CommonMark: closer must be whitespace-only after marker)", async () => {
		// closer の後ろにテキストがあると close ではない。旧実装は startsWith でも閉じ扱い
		// → [[target]] が fenced 外扱いされていた。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(join(workspaceDir, "src.md"), "```\ncode\n``` not-a-closer\n[[target]]\n```");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toEqual([]);
	});

	it("backtick fence opener with backtick in info string is not a fence (CommonMark: info string has no backtick)", async () => {
		// CommonMark / Lezer: ``` opener の info string に backtick は禁止。
		// この行は fence opener ではなく paragraph として扱われ、続く `[[target]]` も
		// 同じ paragraph 内のテキストとして wikilink 判定される。
		// 旧実装は info string を常に許容して fence opener 化 → `[[target]]` を
		// 誤って fenced 内に巻き込み除外していた。tilde fence (~~~) には適用されない。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(join(workspaceDir, "src.md"), "``` info `x`\n[[target]] still real");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(2);
	});

	it("4-space-indented ``` in paragraph continuation is not a fence marker", async () => {
		// CommonMark: paragraph 継続中の 4 spaces indent は indented code block にならず、
		// `` ``` `` も fence marker として認識されない。後続の `[[target]]` も同じ
		// paragraph 内のテキストとして wikilink 判定される。
		// 旧実装は trimmed.startsWith("```") で indent を無視して fence opener 扱い
		// → 続く `[[target]]` が誤って fenced 内と判定され除外されていた。
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(
			join(workspaceDir, "src.md"),
			"paragraph text\n    ```\n[[target]] still a wikilink",
		);
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out).toHaveLength(1);
		expect(out[0].references).toHaveLength(1);
		expect(out[0].references[0].lineNumber).toBe(3);
	});

	it("returns empty when target is not the canonical (lex-smallest) of duplicate basenames", async () => {
		// live-preview の buildFileMap (src/components/editor/live-preview/wikilinks.ts:45)
		// が `[[note]]` を a/note.md に解決する状況で、b/note.md の backlink パネルを
		// 開いても references は出ないことを保証する (表示と実リンクの食い違い防止)。
		await mkdir(join(workspaceDir, "a"), { recursive: true });
		await mkdir(join(workspaceDir, "b"), { recursive: true });
		await writeFile(join(workspaceDir, "a", "note.md"), "# A");
		await writeFile(join(workspaceDir, "b", "note.md"), "# B");
		await writeFile(join(workspaceDir, "other.md"), "[[note]]");

		const outB = await scanBacklinksImpl(
			TEST_WIN,
			workspaceDir,
			join(workspaceDir, "b", "note.md"),
		);
		expect(outB).toEqual([]);

		const outA = await scanBacklinksImpl(
			TEST_WIN,
			workspaceDir,
			join(workspaceDir, "a", "note.md"),
		);
		expect(outA).toHaveLength(1);
		expect(outA[0].sourceFile).toBe(join(workspaceDir, "other.md"));
	});

	it("results are sorted by sourceFile byte order", async () => {
		await writeFile(join(workspaceDir, "target.md"), "");
		await writeFile(join(workspaceDir, "z.md"), "[[target]]");
		await writeFile(join(workspaceDir, "a.md"), "[[target]]");
		const out = await scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		expect(out.map((s) => basename(s.sourceFile))).toEqual(["a.md", "z.md"]);
	});

	it("rejects unauthorized workspace path", async () => {
		await expect(
			scanBacklinksImpl(999 /* not registered */, workspaceDir, join(workspaceDir, "target.md")),
		).rejects.toThrow(/Permission denied/);
	});

	it("rejects unauthorized target file path (workspace 外の target を弾く)", async () => {
		// workspace は registered だが target が登録されていない別 root にある場合、
		// path-guard が `.md` 拡張子フィルタの前で reject することを確認する。
		await expect(
			scanBacklinksImpl(TEST_WIN, workspaceDir, "/some/unauthorized/target.md"),
		).rejects.toThrow(/Permission denied/);
	});

	it("cancelBacklinkScanForWindow stops in-flight backlink scan", async () => {
		await writeFile(join(workspaceDir, "target.md"), "");
		for (let i = 0; i < 10; i++) {
			await writeFile(join(workspaceDir, `f${i}.md`), "[[target]]");
		}
		const promise = scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		cancelBacklinkScanForWindow(TEST_WIN);
		const result = await promise;
		expect(result).toEqual([]);
	});

	it("cancelSearchForWindow does NOT cancel in-flight backlink scan", async () => {
		// regression guard: 全文検索 cancel が backlink scan を巻き込まないこと。
		await writeFile(join(workspaceDir, "target.md"), "");
		for (let i = 0; i < 10; i++) {
			await writeFile(join(workspaceDir, `f${i}.md`), "[[target]]");
		}
		const promise = scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		cancelSearchForWindow(TEST_WIN);
		const result = await promise;
		expect(result).toHaveLength(10);
	});

	it("cancelWikilinkScanForWindow does NOT cancel in-flight backlink scan", async () => {
		// regression guard: 未解決リンク cancel が backlink scan を巻き込まないこと。
		await writeFile(join(workspaceDir, "target.md"), "");
		for (let i = 0; i < 10; i++) {
			await writeFile(join(workspaceDir, `f${i}.md`), "[[target]]");
		}
		const promise = scanBacklinksImpl(TEST_WIN, workspaceDir, join(workspaceDir, "target.md"));
		cancelWikilinkScanForWindow(TEST_WIN);
		const result = await promise;
		expect(result).toHaveLength(10);
	});

	it("cancelBacklinkScanForWindow does NOT cancel in-flight wikilink scan", async () => {
		// regression guard: 逆方向のクロスキャンセル防止。
		for (let i = 0; i < 10; i++) {
			await writeFile(join(workspaceDir, `f${i}.md`), "[[missing]]");
		}
		const promise = scanUnresolvedWikilinksImpl(TEST_WIN, workspaceDir);
		cancelBacklinkScanForWindow(TEST_WIN);
		const result = await promise;
		expect(result).toHaveLength(1);
		expect(result[0].pageName).toBe("missing");
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

	it("excludes node_modules directory (#299)", async () => {
		await mkdir(join(workspaceDir, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(workspaceDir, "node_modules/pkg/README.md"), "match here");
		await writeFile(join(workspaceDir, "node_modules.md"), "match here");
		const out = await searchFilesImpl(TEST_WIN, workspaceDir, "match");
		expect(out).toHaveLength(1);
		expect(out[0].filePath).toContain("node_modules.md");
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
		const { dir: realDir, cleanup: cleanupReal } =
			await createTempWorkspace("scripta-search-real-");
		const { dir: linkDir, cleanup: cleanupLink } =
			await createTempWorkspace("scripta-search-link-");
		// linkDir 自体は実ディレクトリなので、その中に link を張る。
		const symlinkPath = join(linkDir, "ws-link");
		try {
			await writeFile(join(realDir, "note.md"), "hello world");
			await symlink(realDir, symlinkPath, "dir");
			clearWorkspaceRoots();
			await registerWorkspaceRoot(TEST_WIN, symlinkPath);
			const out = await searchFilesImpl(TEST_WIN, symlinkPath, "hello");
			expect(out).toHaveLength(1);
			// filePath は input-base = symlinkPath 配下を指すべき（canonical = realDir 配下では「ない」）
			expect(out[0].filePath.startsWith(symlinkPath)).toBe(true);
			expect(out[0].filePath.startsWith(realDir)).toBe(false);
		} finally {
			await cleanupReal();
			await cleanupLink();
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
