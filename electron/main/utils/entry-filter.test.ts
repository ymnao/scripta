import { beforeEach, describe, expect, it } from "vitest";
import { __testing, createEntryFilter, DEFAULT_FILE_TREE_EXCLUDE_PATTERNS } from "./entry-filter";

const { parsePatterns, clearMatcherCache } = __testing;

const ROOT = "/workspace";

beforeEach(() => {
	clearMatcherCache();
});

describe("createEntryFilter", () => {
	describe("hidden component handling", () => {
		it("hides dotfile when showHidden=false", () => {
			const filter = createEntryFilter({ showHidden: false, excludePatterns: "" }, ROOT);
			expect(filter("/workspace/.gitignore", false)).toBe(false);
			expect(filter("/workspace/.git", true)).toBe(false);
			expect(filter("/workspace/sub/.config/settings.json", false)).toBe(false);
		});

		it("shows non-dotfile when showHidden=false", () => {
			const filter = createEntryFilter({ showHidden: false, excludePatterns: "" }, ROOT);
			expect(filter("/workspace/README.md", false)).toBe(true);
			expect(filter("/workspace/docs/spec.md", false)).toBe(true);
		});

		it("shows dotfile when showHidden=true (without exclude patterns)", () => {
			const filter = createEntryFilter({ showHidden: true, excludePatterns: "" }, ROOT);
			expect(filter("/workspace/.gitignore", false)).toBe(true);
			expect(filter("/workspace/.env", false)).toBe(true);
		});

		it("treats root itself and out-of-root as visible (defensive)", () => {
			const filter = createEntryFilter({ showHidden: false, excludePatterns: "" }, ROOT);
			expect(filter("/workspace", true)).toBe(true);
			expect(filter("/etc/passwd", false)).toBe(true);
		});

		it("does not treat root with dotted ancestor as hidden", () => {
			const filter = createEntryFilter(
				{ showHidden: false, excludePatterns: "" },
				"/Users/me/.notes/project",
			);
			expect(filter("/Users/me/.notes/project/a.md", false)).toBe(true);
			expect(filter("/Users/me/.notes/project/sub/b.md", false)).toBe(true);
			// root 配下の dotfile はちゃんと hidden
			expect(filter("/Users/me/.notes/project/.git/config", false)).toBe(false);
		});
	});

	describe("exclude patterns", () => {
		it("excludes a literal filename anywhere when showHidden=true", () => {
			const filter = createEntryFilter({ showHidden: true, excludePatterns: ".DS_Store\n" }, ROOT);
			expect(filter("/workspace/.DS_Store", false)).toBe(false);
			expect(filter("/workspace/sub/.DS_Store", false)).toBe(false);
			expect(filter("/workspace/notes.md", false)).toBe(true);
		});

		it("treats trailing slash as directory-only", () => {
			const filter = createEntryFilter(
				{ showHidden: true, excludePatterns: "node_modules/\n" },
				ROOT,
			);
			expect(filter("/workspace/node_modules", true)).toBe(false);
			// file named node_modules (rare but possible): shown
			expect(filter("/workspace/node_modules", false)).toBe(true);
		});

		it("supports negation `!`", () => {
			const filter = createEntryFilter(
				{
					showHidden: true,
					excludePatterns: "*.log\n!important.log\n",
				},
				ROOT,
			);
			expect(filter("/workspace/debug.log", false)).toBe(false);
			expect(filter("/workspace/important.log", false)).toBe(true);
		});

		it("ignores `#` comments and blank lines", () => {
			const filter = createEntryFilter(
				{
					showHidden: true,
					excludePatterns: "# top comment\n\nfoo.txt\n# trailing\n",
				},
				ROOT,
			);
			expect(filter("/workspace/foo.txt", false)).toBe(false);
			expect(filter("/workspace/bar.txt", false)).toBe(true);
		});

		it("anchors patterns containing internal `/` to root", () => {
			const filter = createEntryFilter(
				{ showHidden: true, excludePatterns: "build/output\n" },
				ROOT,
			);
			expect(filter("/workspace/build/output", true)).toBe(false);
			expect(filter("/workspace/build/output/a.txt", false)).toBe(false);
			expect(filter("/workspace/sub/build/output", true)).toBe(true);
		});

		it("treats `**/foo` as matches-anywhere", () => {
			const filter = createEntryFilter({ showHidden: true, excludePatterns: "**/foo\n" }, ROOT);
			expect(filter("/workspace/foo", true)).toBe(false);
			expect(filter("/workspace/a/foo", true)).toBe(false);
			expect(filter("/workspace/a/b/foo", true)).toBe(false);
			expect(filter("/workspace/foobar", false)).toBe(true);
		});

		it("treats `**/foo/bar` (multi-segment after **/) as matches-anywhere", () => {
			const filter = createEntryFilter({ showHidden: true, excludePatterns: "**/foo/bar\n" }, ROOT);
			expect(filter("/workspace/foo/bar", true)).toBe(false);
			expect(filter("/workspace/sub/foo/bar", true)).toBe(false);
			expect(filter("/workspace/a/b/foo/bar", true)).toBe(false);
			// `foo/bar` の "bar" は連続したパス要素である必要がある
			expect(filter("/workspace/foo/x/bar", true)).toBe(true);
		});

		it("treats leading `/` as root-anchored", () => {
			const filter = createEntryFilter({ showHidden: true, excludePatterns: "/foo\n" }, ROOT);
			expect(filter("/workspace/foo", true)).toBe(false);
			expect(filter("/workspace/sub/foo", true)).toBe(true);
		});

		it("supports glob `*` (single segment)", () => {
			const filter = createEntryFilter({ showHidden: true, excludePatterns: "*.log\n" }, ROOT);
			expect(filter("/workspace/debug.log", false)).toBe(false);
			expect(filter("/workspace/sub/debug.log", false)).toBe(false);
			expect(filter("/workspace/notes.md", false)).toBe(true);
		});

		it("does not allow `*` to cross `/`", () => {
			const filter = createEntryFilter({ showHidden: true, excludePatterns: "/a*c\n" }, ROOT);
			expect(filter("/workspace/abc", false)).toBe(false);
			expect(filter("/workspace/a/b/c", false)).toBe(true);
		});

		it("default exclude patterns hide .DS_Store / Thumbs.db / .git (when showHidden=true)", () => {
			const filter = createEntryFilter(
				{
					showHidden: true,
					excludePatterns: DEFAULT_FILE_TREE_EXCLUDE_PATTERNS,
				},
				ROOT,
			);
			expect(filter("/workspace/.DS_Store", false)).toBe(false);
			expect(filter("/workspace/Thumbs.db", false)).toBe(false);
			expect(filter("/workspace/.git", true)).toBe(false);
			// .gitignore（既定除外に含まれない隠しファイル）は showHidden=true で見える
			expect(filter("/workspace/.gitignore", false)).toBe(true);
		});

		it("hidden hides win over negation in patterns", () => {
			// showHidden=false 下では `!important` で再包含しても hidden は隠れる
			const filter = createEntryFilter(
				{ showHidden: false, excludePatterns: "!.gitignore\n" },
				ROOT,
			);
			expect(filter("/workspace/.gitignore", false)).toBe(false);
		});

		it("dirOnly pattern hides descendant files (gitignore-compatible)", () => {
			const filter = createEntryFilter({ showHidden: true, excludePatterns: "cache/\n" }, ROOT);
			// dir そのものは isDir=true で hide
			expect(filter("/workspace/cache", true)).toBe(false);
			// 同名のファイル（rare）は dirOnly のため shown
			expect(filter("/workspace/cache", false)).toBe(true);
			// dir 配下のファイル / dir も hide される（gitignore 仕様）
			expect(filter("/workspace/cache/keep.md", false)).toBe(false);
			expect(filter("/workspace/cache/sub", true)).toBe(false);
			expect(filter("/workspace/cache/sub/x.md", false)).toBe(false);
		});

		it("negation re-includes a child even if parent dir was excluded (差分仕様)", () => {
			// gitignore 厳密仕様では「親 dir 除外配下の `!child` は再包含されない」が、
			// 本実装は「最後にマッチしたルールが勝つ」単純規則のためここでは再包含する。
			// UI 側で limitation を明記する。
			const filter = createEntryFilter(
				{ showHidden: true, excludePatterns: "cache/\n!cache/keep.md\n" },
				ROOT,
			);
			expect(filter("/workspace/cache/keep.md", false)).toBe(true);
			expect(filter("/workspace/cache/other.md", false)).toBe(false);
		});

		it("isDir=undefined hides dirOnly matches (chokidar stats-less path)", () => {
			const filter = createEntryFilter(
				{ showHidden: true, excludePatterns: ".git/\nfoo.md\n" },
				ROOT,
			);
			// .git は dirOnly。stats なしでも hide される
			expect(filter("/workspace/.git", undefined)).toBe(false);
			// non-dirOnly パターンも当然 hide
			expect(filter("/workspace/foo.md", undefined)).toBe(false);
			// マッチしないものは show
			expect(filter("/workspace/regular.md", undefined)).toBe(true);
		});
	});
});

describe("parsePatterns (direct)", () => {
	it("treats `?` as single non-slash character", () => {
		const m = parsePatterns("a?c");
		expect(m.isMatched("abc", false)).toBe(true);
		expect(m.isMatched("ac", false)).toBe(false);
		expect(m.isMatched("a/c", false)).toBe(false);
	});

	it("escapes regex metacharacters in literals", () => {
		const m = parsePatterns("a+b.c\n");
		expect(m.isMatched("a+b.c", false)).toBe(true);
		expect(m.isMatched("aXbYc", false)).toBe(false);
	});

	it("handles CRLF line endings", () => {
		const m = parsePatterns("foo\r\nbar\r\n");
		expect(m.isMatched("foo", false)).toBe(true);
		expect(m.isMatched("bar", false)).toBe(true);
	});

	it("ignores trailing whitespace on pattern lines", () => {
		const m = parsePatterns("  foo  \n");
		expect(m.isMatched("foo", false)).toBe(true);
	});
});
