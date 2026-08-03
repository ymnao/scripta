// @vitest-environment node
import {
	lstat,
	mkdir,
	open,
	readFile,
	readlink,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempWorkspace, type TempWorkspace } from "../test-utils/temp-workspace";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
	shell: {
		trashItem: vi.fn(async () => {}),
	},
}));

import { shell } from "electron";
import {
	canonicalize,
	clearWorkspaceRoots,
	getTransientWritePathsForWindow,
	registerTransientWritePath,
	registerWorkspaceRoot,
} from "../utils/path-guard";
import { __testing, MAX_READ_FILE_BYTES } from "./fs";

const TEST_WIN = 1;
const OTHER_WIN = 2;

const {
	existsBy,
	readFileImpl,
	readFileBase64Impl,
	readFileBoundedFromHandle,
	writeFileImpl,
	writeNewFileImpl,
	listDirectoryImpl,
	createFileImpl,
	createDirectoryImpl,
	pathExistsImpl,
	fileExistsImpl,
	renameEntryImpl,
	deleteEntryImpl,
} = __testing;

let workspaceDir = "";
let ws: TempWorkspace;

// 実 I/O を発生させずに stat.size だけを膨らませた sparse file を作る test 用 helper。
// `truncate` は logical size のみ設定し物理ブロックを割り当てない（disk 占有ゼロ）。
async function createSparseFile(path: string, size: number): Promise<void> {
	const fh = await open(path, "w");
	try {
		await fh.truncate(size);
	} finally {
		await fh.close();
	}
}

beforeEach(async () => {
	clearWorkspaceRoots();
	ws = await createTempWorkspace("scripta-fs-test-");
	workspaceDir = ws.dir;
	await registerWorkspaceRoot(TEST_WIN, workspaceDir);
	vi.mocked(shell.trashItem).mockClear();
});

afterEach(async () => {
	clearWorkspaceRoots();
	await ws.cleanup();
});

describe("readFileImpl", () => {
	it("reads UTF-8 content from a file", async () => {
		const path = join(workspaceDir, "hello.md");
		await writeFile(path, "こんにちは\n世界", "utf8");
		expect(await readFileImpl(TEST_WIN, path)).toBe("こんにちは\n世界");
	});

	it("throws ENOENT when the file is missing", async () => {
		const path = join(workspaceDir, "missing.md");
		await expect(readFileImpl(TEST_WIN, path)).rejects.toThrow(/ENOENT/);
	});

	it("rejects relative paths", async () => {
		await expect(readFileImpl(TEST_WIN, "relative.md")).rejects.toThrow(
			/Invalid path: must be absolute/,
		);
	});

	it("rejects reads from another window's workspace (window-scoped guard)", async () => {
		// この再現が、レビュー指摘の本質：別ウィンドウ workspace 配下を覗けてはいけない
		const path = join(workspaceDir, "shared.md");
		await writeFile(path, "secret", "utf8");
		await expect(readFileImpl(OTHER_WIN, path)).rejects.toThrow(/Permission denied/);
	});

	it("rejects files exceeding MAX_READ_FILE_BYTES with FILE_TOO_LARGE", async () => {
		const huge = join(workspaceDir, "huge.bin");
		await createSparseFile(huge, MAX_READ_FILE_BYTES + 1);
		await expect(readFileImpl(TEST_WIN, huge)).rejects.toThrow(/File too large/);
		await expect(readFileImpl(TEST_WIN, huge)).rejects.toMatchObject({ kind: "FILE_TOO_LARGE" });
	});

	it("allows files at exactly MAX_READ_FILE_BYTES (boundary)", async () => {
		// 境界条件: 上限「ちょうど」は許可される（> での比較なので == はパス）。
		// 64MB 実 read は重いが、内容は空（sparse 領域 → read で 0x00 連続）なので
		// 物理 I/O は発生しない。長さが size ぴったりであることまで verify する。
		const boundary = join(workspaceDir, "boundary.bin");
		await createSparseFile(boundary, MAX_READ_FILE_BYTES);
		await expect(readFileImpl(TEST_WIN, boundary)).resolves.toHaveLength(MAX_READ_FILE_BYTES);
	});
});

describe("readFileBase64Impl (#314 data URI 埋め込み用)", () => {
	it("reads a png as base64", async () => {
		const path = join(workspaceDir, "hero.png");
		// 8-byte PNG magic + minimal payload
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		await writeFile(path, bytes);
		const b64 = await readFileBase64Impl(TEST_WIN, path);
		expect(b64).toBe(bytes.toString("base64"));
		expect(Buffer.from(b64, "base64")).toEqual(bytes);
	});

	it("reads a jpeg as base64", async () => {
		const path = join(workspaceDir, "photo.jpg");
		const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
		await writeFile(path, bytes);
		const b64 = await readFileBase64Impl(TEST_WIN, path);
		expect(Buffer.from(b64, "base64")).toEqual(bytes);
	});

	it("rejects non-image extensions (mp4)", async () => {
		const path = join(workspaceDir, "video.mp4");
		await writeFile(path, Buffer.from([0x00]));
		await expect(readFileBase64Impl(TEST_WIN, path)).rejects.toThrow(/unsupported extension/);
	});

	it("rejects extensionless files", async () => {
		const path = join(workspaceDir, "README");
		await writeFile(path, Buffer.from([0x00]));
		await expect(readFileBase64Impl(TEST_WIN, path)).rejects.toThrow(/unsupported extension/);
	});

	it("case-insensitive extension check (PNG)", async () => {
		const path = join(workspaceDir, "A.PNG");
		const bytes = Buffer.from([0x89, 0x50]);
		await writeFile(path, bytes);
		const b64 = await readFileBase64Impl(TEST_WIN, path);
		expect(Buffer.from(b64, "base64")).toEqual(bytes);
	});

	it("rejects paths outside workspace (path-guard)", async () => {
		const outside = join(tmpdir(), "scripta-outside.png");
		await writeFile(outside, Buffer.from([0x00]));
		try {
			await expect(readFileBase64Impl(TEST_WIN, outside)).rejects.toThrow(/outside workspace/);
		} finally {
			await rm(outside, { force: true });
		}
	});

	it("rejects paths not registered by this window (window-scoped)", async () => {
		const path = join(workspaceDir, "hero.png");
		await writeFile(path, Buffer.from([0x89, 0x50]));
		await expect(readFileBase64Impl(OTHER_WIN, path)).rejects.toThrow(/outside workspace/);
	});

	it("rejects files exceeding MAX_READ_FILE_BYTES", async () => {
		const path = join(workspaceDir, "huge.png");
		await createSparseFile(path, MAX_READ_FILE_BYTES + 1);
		await expect(readFileBase64Impl(TEST_WIN, path)).rejects.toThrow(/too large|FILE_TOO_LARGE/i);
	});

	it("throws ENOENT for missing file", async () => {
		const path = join(workspaceDir, "missing.png");
		await expect(readFileBase64Impl(TEST_WIN, path)).rejects.toThrow(/ENOENT/);
	});
});

describe("readFileBoundedFromHandle (stat の信頼性に依存しない bounded read)", () => {
	// stat 申告と実 read を独立に制御する fake FileHandle。
	// stat.size と read の data を別個に指定できるので、外部書込（file watcher 経路）
	// で stat → read 間に追記される race の振る舞いを単体テストできる。
	function makeFakeHandle(
		data: Buffer,
		opts: { spoofStatSize?: number } = {},
	): import("node:fs/promises").FileHandle {
		let pos = 0;
		return {
			stat: async () => ({ size: opts.spoofStatSize ?? data.length }),
			read: async (buf: Buffer, off: number, len: number) => {
				const slice = data.subarray(pos, pos + len);
				slice.copy(buf, off);
				pos += slice.length;
				return { bytesRead: slice.length, buffer: buf };
			},
		} as unknown as import("node:fs/promises").FileHandle;
	}

	const LIMIT = 1024;

	it("reads the full content when stat is accurate", async () => {
		const fh = makeFakeHandle(Buffer.from("hello"));
		expect(await readFileBoundedFromHandle(fh, "/fake", LIMIT)).toBe("hello");
	});

	it("returns empty string for empty file", async () => {
		const fh = makeFakeHandle(Buffer.alloc(0));
		expect(await readFileBoundedFromHandle(fh, "/fake", LIMIT)).toBe("");
	});

	it("accepts files that grow between stat and read while staying under the limit", async () => {
		// stat 後に外部書込で実 size が膨らんだ場合（file watcher 経路の典型）でも、
		// 実 size が limit 以下なら正常に受け入れる。前回実装は申告超で誤検知していた。
		const data = Buffer.from("x".repeat(900));
		const fh = makeFakeHandle(data, { spoofStatSize: 50 });
		expect(await readFileBoundedFromHandle(fh, "/fake", LIMIT)).toBe("x".repeat(900));
	});

	it("rejects when actual content exceeds the limit even if stat under-reports", async () => {
		// stat が嘘 / append で limit を超えた場合は確実に reject する。bounded buffer
		// は limit+1 byte（hardCap）まで段階拡張するため、limit+1 byte 読めた時点で
		// 上限超が確定する。
		const data = Buffer.from("x".repeat(LIMIT + 1));
		await expect(
			readFileBoundedFromHandle(makeFakeHandle(data, { spoofStatSize: 50 }), "/fake", LIMIT),
		).rejects.toThrow(/File too large/);
		await expect(
			readFileBoundedFromHandle(makeFakeHandle(data, { spoofStatSize: 50 }), "/fake", LIMIT),
		).rejects.toMatchObject({ kind: "FILE_TOO_LARGE" });
	});

	it("rejects early when stat already reports above the limit (no read syscall needed)", async () => {
		// 早期 reject: stat 申告で limit を超えていれば、無駄に buffer を allocate せず
		// 即 throw。read は呼ばれないので消費 0。
		const data = Buffer.from("y".repeat(2 * LIMIT));
		const fh = makeFakeHandle(data, { spoofStatSize: 2 * LIMIT });
		await expect(readFileBoundedFromHandle(fh, "/fake", LIMIT)).rejects.toThrow(/File too large/);
	});
});

describe("writeFileImpl", () => {
	it("writes content to a new file", async () => {
		const path = join(workspaceDir, "out.md");
		await writeFileImpl(TEST_WIN, path, "abc");
		expect(await readFile(path, "utf8")).toBe("abc");
	});

	it("creates parent directories as needed", async () => {
		const path = join(workspaceDir, "a", "b", "c", "deep.md");
		await writeFileImpl(TEST_WIN, path, "nested");
		expect(await readFile(path, "utf8")).toBe("nested");
	});

	it("overwrites an existing file", async () => {
		const path = join(workspaceDir, "out.md");
		await writeFile(path, "original", "utf8");
		await writeFileImpl(TEST_WIN, path, "replaced");
		expect(await readFile(path, "utf8")).toBe("replaced");
	});

	it("rejects writes outside the registered workspace", async () => {
		const outside = join(tmpdir(), "scripta-outside.md");
		await expect(writeFileImpl(TEST_WIN, outside, "x")).rejects.toThrow(/Permission denied/);
	});

	it("permits a SaveDialog-style transient write path and consumes it on success", async () => {
		const outside = join(tmpdir(), `scripta-outside-success-${Date.now()}.md`);
		await registerTransientWritePath(TEST_WIN, outside);
		try {
			await writeFileImpl(TEST_WIN, outside, "exported");
			expect(await readFile(outside, "utf8")).toBe("exported");
			// 成功後に transient capability は consume される
			expect(getTransientWritePathsForWindow(TEST_WIN)).toEqual([]);
		} finally {
			await rm(outside, { force: true });
		}
	});

	it("does NOT consume the transient when the write fails (retry-friendly)", async () => {
		// 親ディレクトリ書き込み失敗を擬似的に作る代わりに、failure path として
		// 「対象自体がディレクトリ」のケースを使う（writeFile が EISDIR を返す）。
		const { dir: outsideDir, cleanup } = await createTempWorkspace("scripta-outside-dir-");
		try {
			await registerTransientWritePath(TEST_WIN, outsideDir);
			await expect(writeFileImpl(TEST_WIN, outsideDir, "x")).rejects.toThrow();
			// 失敗したので transient はまだ残っており、withRetry で再試行可能
			expect(getTransientWritePathsForWindow(TEST_WIN)).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	it("rejects when another window's transient is used (no cross-window leakage)", async () => {
		const outside = join(tmpdir(), `scripta-outside-cross-${Date.now()}.md`);
		await registerTransientWritePath(OTHER_WIN, outside);
		await expect(writeFileImpl(TEST_WIN, outside, "x")).rejects.toThrow(/Permission denied/);
	});
});

describe("writeNewFileImpl", () => {
	it("creates a new file with content", async () => {
		const path = join(workspaceDir, "new.md");
		await writeNewFileImpl(TEST_WIN, path, "fresh");
		expect(await readFile(path, "utf8")).toBe("fresh");
	});

	it("creates parent directories", async () => {
		const path = join(workspaceDir, "a", "b", "new.md");
		await writeNewFileImpl(TEST_WIN, path, "nested");
		expect(await readFile(path, "utf8")).toBe("nested");
	});

	it("fails atomically when the file already exists (preserves original)", async () => {
		const path = join(workspaceDir, "exist.md");
		await writeFile(path, "original", "utf8");
		await expect(writeNewFileImpl(TEST_WIN, path, "overwrite")).rejects.toThrow(/EEXIST/);
		expect(await readFile(path, "utf8")).toBe("original");
	});

	it("rejects writes outside the registered workspace", async () => {
		const outside = join(tmpdir(), "scripta-outside.md");
		await expect(writeNewFileImpl(TEST_WIN, outside, "x")).rejects.toThrow(/Permission denied/);
	});

	it("does NOT consume the transient on EEXIST failure", async () => {
		const outside = join(tmpdir(), `scripta-outside-exists-${Date.now()}.md`);
		await writeFile(outside, "preexisting", "utf8");
		try {
			await registerTransientWritePath(TEST_WIN, outside);
			await expect(writeNewFileImpl(TEST_WIN, outside, "new")).rejects.toThrow(/EEXIST/);
			expect(getTransientWritePathsForWindow(TEST_WIN)).toHaveLength(1);
		} finally {
			await rm(outside, { force: true });
		}
	});
});

describe("listDirectoryImpl", () => {
	it("returns files and directories with metadata", async () => {
		await writeFile(join(workspaceDir, "a.md"), "", "utf8");
		await writeFile(join(workspaceDir, "b.md"), "", "utf8");
		const sub = join(workspaceDir, "sub");
		await mkdir(sub);

		const entries = await listDirectoryImpl(TEST_WIN, workspaceDir);
		const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
		expect(sorted).toHaveLength(3);
		// 戻り値の path は renderer 側 workspacePath（raw 入力）と整合させるため
		// canonical ではなく入力表記を base にする（symlink workspace / macOS /var 等の
		// ズレで FileTree の replacePrefix が崩れないように）
		expect(sorted[0]).toEqual({
			name: "a.md",
			path: join(workspaceDir, "a.md"),
			isDirectory: false,
		});
		expect(sorted[1]).toEqual({
			name: "b.md",
			path: join(workspaceDir, "b.md"),
			isDirectory: false,
		});
		expect(sorted[2]).toEqual({
			name: "sub",
			path: join(workspaceDir, "sub"),
			isDirectory: true,
		});
	});

	it("returns an empty array for an empty directory", async () => {
		expect(await listDirectoryImpl(TEST_WIN, workspaceDir)).toEqual([]);
	});

	it("throws ENOENT for a missing directory", async () => {
		await expect(listDirectoryImpl(TEST_WIN, join(workspaceDir, "nope"))).rejects.toThrow(/ENOENT/);
	});

	it("rejects list from another window (window-scoped guard)", async () => {
		await expect(listDirectoryImpl(OTHER_WIN, workspaceDir)).rejects.toThrow(/Permission denied/);
	});

	// 本テスト環境では electron.app が mock 未提供のため getFileTreeFilterOptions()
	// は catch ブランチで既定値（showHidden=false + DEFAULT_FILE_TREE_EXCLUDE_PATTERNS）を返す。
	// FileTree 用の opt-in を渡したケースだけ dotfile / .git/ が除外され、デフォルト呼び出しでは
	// すべて返す（DirectoryPicker / scripta-config 経路の挙動を保証）。
	it("filters hidden files only when applyFileTreeFilter=true", async () => {
		await writeFile(join(workspaceDir, "regular.md"), "", "utf8");
		await writeFile(join(workspaceDir, ".gitignore"), "", "utf8");
		await writeFile(join(workspaceDir, ".DS_Store"), "", "utf8");
		await mkdir(join(workspaceDir, ".git"));
		await mkdir(join(workspaceDir, "docs"));

		const filtered = await listDirectoryImpl(TEST_WIN, workspaceDir, {
			applyFileTreeFilter: true,
		});
		expect(filtered.map((e) => e.name).sort()).toEqual(["docs", "regular.md"]);

		const unfiltered = await listDirectoryImpl(TEST_WIN, workspaceDir);
		expect(unfiltered.map((e) => e.name).sort()).toEqual([
			".DS_Store",
			".git",
			".gitignore",
			"docs",
			"regular.md",
		]);
	});
});

describe("createFileImpl", () => {
	it("creates an empty file", async () => {
		const path = join(workspaceDir, "new.md");
		await createFileImpl(TEST_WIN, path);
		expect(await readFile(path, "utf8")).toBe("");
	});

	it("creates parent directories", async () => {
		const path = join(workspaceDir, "deep", "x", "new.md");
		await createFileImpl(TEST_WIN, path);
		expect(await readFile(path, "utf8")).toBe("");
	});

	it("throws Already exists when the file is already present", async () => {
		const path = join(workspaceDir, "exists.md");
		await writeFile(path, "", "utf8");
		await expect(createFileImpl(TEST_WIN, path)).rejects.toThrow(/^Already exists:/);
		await expect(createFileImpl(TEST_WIN, path)).rejects.toMatchObject({ kind: "ALREADY_EXISTS" });
	});

	it("rejects creation outside the workspace", async () => {
		const outside = join(tmpdir(), "scripta-outside-create.md");
		await expect(createFileImpl(TEST_WIN, outside)).rejects.toThrow(/Permission denied/);
		await expect(createFileImpl(TEST_WIN, outside)).rejects.toMatchObject({
			kind: "PATH_OUTSIDE_WORKSPACE",
		});
	});
});

describe("createDirectoryImpl", () => {
	it("creates a new directory", async () => {
		const path = join(workspaceDir, "new-dir");
		await createDirectoryImpl(TEST_WIN, path);
		const s = await stat(path);
		expect(s.isDirectory()).toBe(true);
	});

	it("creates intermediate directories", async () => {
		const path = join(workspaceDir, "a", "b", "c");
		await createDirectoryImpl(TEST_WIN, path);
		const s = await stat(path);
		expect(s.isDirectory()).toBe(true);
	});

	it("throws Already exists when the directory exists", async () => {
		const path = join(workspaceDir, "dir");
		await createDirectoryImpl(TEST_WIN, path);
		await expect(createDirectoryImpl(TEST_WIN, path)).rejects.toThrow(/^Already exists:/);
		await expect(createDirectoryImpl(TEST_WIN, path)).rejects.toMatchObject({
			kind: "ALREADY_EXISTS",
		});
	});
});

// 存在判定の共通土台。「ENOENT のみ false・他は伝播」は、権限エラーを Not found /
// Source not found と誤分類しないための方針なので、errno ごとの分岐をここで pin する
// （probe を注入して実 fs の権限状態に依存させない）。
describe("existsBy (存在判定の errno ポリシー)", () => {
	function errnoError(code: string): NodeJS.ErrnoException {
		return Object.assign(new Error(code), { code });
	}

	it("probe が解決すれば true を返し、渡された path をそのまま probe する", async () => {
		const probe = vi.fn(async () => undefined);
		expect(await existsBy(probe, "/tmp/x.md")).toBe(true);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(probe).toHaveBeenCalledWith("/tmp/x.md");
	});

	it("ENOENT は false に落とす", async () => {
		expect(
			await existsBy(async () => {
				throw errnoError("ENOENT");
			}, "/tmp/x.md"),
		).toBe(false);
	});

	it("ENOENT 以外（EACCES 等）は握りつぶさず伝播する", async () => {
		// ここを catch-all にすると、権限で見えないだけの path が「無い」と report され、
		// delete / rename が Not found / Source not found を誤って返す。
		await expect(
			existsBy(async () => {
				throw errnoError("EACCES");
			}, "/tmp/x.md"),
		).rejects.toMatchObject({ code: "EACCES" });
		await expect(
			existsBy(async () => {
				throw errnoError("ELOOP");
			}, "/tmp/x.md"),
		).rejects.toMatchObject({ code: "ELOOP" });
	});
});

describe("pathExistsImpl / fileExistsImpl", () => {
	it("pathExists returns true for an existing file", async () => {
		const path = join(workspaceDir, "f.md");
		await writeFile(path, "", "utf8");
		expect(await pathExistsImpl(TEST_WIN, path)).toBe(true);
	});

	it("pathExists returns true for an existing directory", async () => {
		expect(await pathExistsImpl(TEST_WIN, workspaceDir)).toBe(true);
	});

	it("pathExists returns false for a missing entry", async () => {
		expect(await pathExistsImpl(TEST_WIN, join(workspaceDir, "missing"))).toBe(false);
	});

	it("fileExists returns true only for files (not directories)", async () => {
		const path = join(workspaceDir, "file.md");
		await writeFile(path, "", "utf8");
		expect(await fileExistsImpl(TEST_WIN, path)).toBe(true);
		expect(await fileExistsImpl(TEST_WIN, workspaceDir)).toBe(false);
	});

	it("fileExists returns false when missing", async () => {
		expect(await fileExistsImpl(TEST_WIN, join(workspaceDir, "missing.md"))).toBe(false);
	});

	it("rejects pathExists / fileExists from another window", async () => {
		const path = join(workspaceDir, "f.md");
		await writeFile(path, "", "utf8");
		await expect(pathExistsImpl(OTHER_WIN, path)).rejects.toThrow(/Permission denied/);
		await expect(fileExistsImpl(OTHER_WIN, path)).rejects.toThrow(/Permission denied/);
	});
});

describe("renameEntryImpl", () => {
	it("renames a file", async () => {
		const oldPath = join(workspaceDir, "old.md");
		const newPath = join(workspaceDir, "new.md");
		await writeFile(oldPath, "content", "utf8");
		await renameEntryImpl(TEST_WIN, oldPath, newPath);
		expect(await pathExistsImpl(TEST_WIN, oldPath)).toBe(false);
		expect(await readFile(newPath, "utf8")).toBe("content");
	});

	it("creates the destination's parent directory if missing", async () => {
		const oldPath = join(workspaceDir, "old.md");
		const newPath = join(workspaceDir, "moved", "deep", "new.md");
		await writeFile(oldPath, "x", "utf8");
		await renameEntryImpl(TEST_WIN, oldPath, newPath);
		expect(await readFile(newPath, "utf8")).toBe("x");
	});

	it("throws Source not found when missing", async () => {
		const oldPath = join(workspaceDir, "missing.md");
		const newPath = join(workspaceDir, "new.md");
		await expect(renameEntryImpl(TEST_WIN, oldPath, newPath)).rejects.toThrow(/^Source not found:/);
		await expect(renameEntryImpl(TEST_WIN, oldPath, newPath)).rejects.toMatchObject({
			kind: "SOURCE_NOT_FOUND",
		});
	});

	it("throws Target already exists when destination exists", async () => {
		const oldPath = join(workspaceDir, "old.md");
		const newPath = join(workspaceDir, "new.md");
		await writeFile(oldPath, "a", "utf8");
		await writeFile(newPath, "b", "utf8");
		await expect(renameEntryImpl(TEST_WIN, oldPath, newPath)).rejects.toThrow(
			/^Target already exists:/,
		);
		await expect(renameEntryImpl(TEST_WIN, oldPath, newPath)).rejects.toMatchObject({
			kind: "TARGET_ALREADY_EXISTS",
		});
	});

	it("rejects when either side is outside the workspace", async () => {
		const inside = join(workspaceDir, "f.md");
		await writeFile(inside, "", "utf8");
		const outside = join(tmpdir(), "scripta-outside-rename.md");
		await expect(renameEntryImpl(TEST_WIN, inside, outside)).rejects.toThrow(/Permission denied/);
		await expect(renameEntryImpl(TEST_WIN, outside, inside)).rejects.toThrow(/Permission denied/);
	});

	it("rejects rename from another window", async () => {
		const oldPath = join(workspaceDir, "old.md");
		const newPath = join(workspaceDir, "new.md");
		await writeFile(oldPath, "x", "utf8");
		await expect(renameEntryImpl(OTHER_WIN, oldPath, newPath)).rejects.toThrow(/Permission denied/);
	});
});

describe("deleteEntryImpl", () => {
	it("calls shell.trashItem for an existing file (with canonical path)", async () => {
		const path = join(workspaceDir, "f.md");
		await writeFile(path, "", "utf8");
		await deleteEntryImpl(TEST_WIN, path);
		expect(shell.trashItem).toHaveBeenCalledTimes(1);
		// trashItem には canonical（realpath 済み）が渡される — 判定と I/O で同じ
		// パスを使うことで TOCTOU を防ぐ。symlink 差し替え攻撃で workspace 外の
		// ファイルを誤削除しないことの担保
		expect(shell.trashItem).toHaveBeenCalledWith(await canonicalize(path));
	});

	it("throws Not found for missing entries", async () => {
		const path = join(workspaceDir, "missing.md");
		await expect(deleteEntryImpl(TEST_WIN, path)).rejects.toThrow(/^Not found:/);
		await expect(deleteEntryImpl(TEST_WIN, path)).rejects.toMatchObject({ kind: "NOT_FOUND" });
		expect(shell.trashItem).not.toHaveBeenCalled();
	});

	it("rejects deletes outside the workspace", async () => {
		const outside = join(tmpdir(), "scripta-outside-delete.md");
		await writeFile(outside, "", "utf8").catch(() => {});
		await expect(deleteEntryImpl(TEST_WIN, outside)).rejects.toThrow(/Permission denied/);
		await rm(outside, { force: true });
	});

	it("rejects delete from another window", async () => {
		const path = join(workspaceDir, "f.md");
		await writeFile(path, "", "utf8");
		await expect(deleteEntryImpl(OTHER_WIN, path)).rejects.toThrow(/Permission denied/);
	});
});

// #418 / #453: 末端 component が symlink である path を fs IPC がどう扱うかの pin。2 つの性質を
// 分けて押さえる:
//
//  1. **realpath で解決できない symlink は O_NOFOLLOW が拒否する (#418)**。認可時点で canonical の
//     末端が symlink のまま残るのは realpathBestEffort が祖先 fall-through した場合、すなわち
//     realpath がその path を解決できなかったとき (dangling / 循環 symlink 等)。以下の fixture は
//     dangling を使う。plain な open だと write が解決先 (workspace 外) を新規作成してしまう
//  2. **前回の認可を持ち越さない (#453)**。realpath cache を撤去したので、一度 read / write を
//     通した path でも、その後 symlink へ retarget されれば次の認可は新しい解決先で判定する。
//     cache があった頃はここが「ガードは古い canonical を通すが末端は今 symlink」という
//     swap 窓の終状態になり、O_NOFOLLOW + 再認可で受け止めていた
//
// race そのものは再現せず、終状態を disk 上に作って決定的に検証する (open-nofollow.test.ts と
// 同方針)。2 の test が「一度呼んでから retarget する」形なのは、**前回の認可結果が残らないこと**
// 自体を pin するため (cache を再導入すると、stale な canonical の末端が今は symlink なので
// O_NOFOLLOW open が ELOOP を返し、期待している PATH_OUTSIDE_WORKSPACE / 解決先の内容に届かない
// = 実測で 6 本とも落ちる)。
//
// win32 は O_NOFOLLOW が無く flag が 0 に落ちるため拒否 assert が成立しない (#451 で追跡)。
describe.skipIf(process.platform === "win32")("末端 symlink の境界 (#418 / #453)", () => {
	let outside: TempWorkspace;

	beforeEach(async () => {
		outside = await createTempWorkspace("scripta-fs-outside-");
	});

	afterEach(async () => {
		await outside.cleanup();
	});

	describe("read", () => {
		it("workspace 内の実体を指す alias は従来どおり読める (O_NOFOLLOW を発火させない)", async () => {
			const real = join(workspaceDir, "real.md");
			await writeFile(real, "real body", "utf8");
			const alias = join(workspaceDir, "alias.md");
			await symlink(real, alias);
			// canonical が実体側 (非 symlink) に解決されるため、正当な symlink note は壊れない
			expect(await readFileImpl(TEST_WIN, alias)).toBe("real body");
		});

		it("dangling symlink の read は ELOOP で失敗する", async () => {
			// realpath が解決できず canonical が symlink 自身の path になるため O_NOFOLLOW が
			// 発火する。plain open だと ENOENT になるので errno まで pin する。
			const link = join(workspaceDir, "dangling.md");
			await symlink(join(outside.dir, "nope.md"), link);
			const err = await readFileImpl(TEST_WIN, link).catch((e: NodeJS.ErrnoException) => e);
			expect((err as NodeJS.ErrnoException).code).toBe("ELOOP");
		});

		it("workspace 外の実体を指す symlink はガードが拒否する", async () => {
			const secret = join(outside.dir, "secret.md");
			await writeFile(secret, "SECRET", "utf8");
			const link = join(workspaceDir, "evil.md");
			await symlink(secret, link);
			// realpath が成功して外部を指すので、O_NOFOLLOW ではなく path-guard が落とす
			await expect(readFileImpl(TEST_WIN, link)).rejects.toThrow(/outside workspace/);
		});

		it("一度 read した path が workspace 外への symlink へ retarget されたら外部内容を返さない", async () => {
			// **前回の認可を持ち越さないこと**の pin (#453)。realpath cache があった頃は、1 度読んで
			// cache に載せた path を symlink へ差し替えると「ガードは古い canonical を通すが、その
			// canonical の末端は今 symlink」という swap 窓の終状態になり、O_NOFOLLOW の ELOOP →
			// cache 破棄 → 再認可でようやく拒否に届いていた。cache 撤去後は 2 度目の認可が fresh に
			// 解決するので、ガード自身が外部を検出して落とす。cache を再導入すると canonical が
			// stale になり、ELOOP (≠ PATH_OUTSIDE_WORKSPACE) が出てこの test は落ちる。
			const secret = join(outside.dir, "secret.md");
			await writeFile(secret, "SECRET", "utf8");
			const path = join(workspaceDir, "note.md");
			await writeFile(path, "innocent", "utf8");
			expect(await readFileImpl(TEST_WIN, path)).toBe("innocent");

			await rm(path);
			await symlink(secret, path);

			// 主 assert は「外部内容を返さないこと」。表に出るのは errno ではなく認可エラーになる。
			const err = await readFileImpl(TEST_WIN, path).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).not.toContain("SECRET");
			expect(err).toMatchObject({ kind: "PATH_OUTSIDE_WORKSPACE" });
		});

		it("一度 read した path が workspace 内の alias へ retarget されたら解決先を読む", async () => {
			// 同じ retarget でも、解決先が workspace 内なら**正当な alias 化** (git checkout /
			// 同期クライアント等)。成否が「その path を過去に読んだか」で変わらないことを pin する。
			// cache を再導入すると canonical は cache 時点の note.md のままで、その末端が今は
			// symlink なので O_NOFOLLOW open が ELOOP を返して落ちる。
			const real = join(workspaceDir, "real.md");
			await writeFile(real, "real body", "utf8");
			const path = join(workspaceDir, "note.md");
			await writeFile(path, "innocent", "utf8");
			expect(await readFileImpl(TEST_WIN, path)).toBe("innocent");

			await rm(path);
			await symlink(real, path);

			expect(await readFileImpl(TEST_WIN, path)).toBe("real body");
		});

		it("dangling symlink の read-base64 も ELOOP で失敗する", async () => {
			const link = join(workspaceDir, "dangling.png");
			await symlink(join(outside.dir, "nope.png"), link);
			const err = await readFileBase64Impl(TEST_WIN, link).catch((e: NodeJS.ErrnoException) => e);
			expect((err as NodeJS.ErrnoException).code).toBe("ELOOP");
		});

		it("read-base64 も retarget 後に外部内容を返さない", async () => {
			// readFileImpl と同じ終状態を data URI 埋め込み経路 (#314) でも pin する。
			const secret = join(outside.dir, "secret.png");
			await writeFile(secret, Buffer.from([0xde, 0xad]));
			const path = join(workspaceDir, "hero.png");
			await writeFile(path, Buffer.from([0x89, 0x50]));
			await readFileBase64Impl(TEST_WIN, path);

			await rm(path);
			await symlink(secret, path);

			const err = await readFileBase64Impl(TEST_WIN, path).catch((e: unknown) => e);
			expect(err).toMatchObject({ kind: "PATH_OUTSIDE_WORKSPACE" });
		});
	});

	describe("write", () => {
		it("dangling symlink 経由で workspace 外に file を作らせない", async () => {
			// #418 の本命 regression test。plain な fsp.writeFile 実装ではこの write が成功し、
			// symlink の解決先 (workspace 外) に file が新規作成される。
			const escapeTarget = join(outside.dir, "created-by-escape.md");
			const link = join(workspaceDir, "note.md");
			await symlink(escapeTarget, link);

			const err = await writeFileImpl(TEST_WIN, link, "escaped").catch(
				(e: NodeJS.ErrnoException) => e,
			);
			expect(err).toBeInstanceOf(Error);
			expect((err as NodeJS.ErrnoException).code).toBe("ELOOP");
			// 主 assert: workspace 外に file が作られていないこと
			await expect(stat(escapeTarget)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("一度 write した path が外部 file への symlink へ retarget されたら上書きしない", async () => {
			// read 側と同じ終状態を write で作る。dangling symlink 経由の escape が「新規作成」
			// だけなのに対し、この経路は **既存の外部 file の上書き**まで届く。
			const victim = join(outside.dir, "victim.md");
			await writeFile(victim, "original", "utf8");
			const path = join(workspaceDir, "note.md");
			await writeFile(path, "innocent", "utf8");
			await writeFileImpl(TEST_WIN, path, "innocent2");

			await rm(path);
			await symlink(victim, path);

			const err = await writeFileImpl(TEST_WIN, path, "overwritten").catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Error);
			expect(err).toMatchObject({ kind: "PATH_OUTSIDE_WORKSPACE" });
			expect(await readFile(victim, "utf8")).toBe("original");
		});

		it("transient write path が retarget されたら次の認可が拒否し、capability も消費しない", async () => {
			// SaveDialog 由来の transient は canonical 一致でしか通らない。認可は毎回 fresh に
			// realpath するので、retarget 後の解決先は登録済み canonical と一致せず拒否される。
			// consume は write 成功後だけなので capability は残る（renderer の withRetry 契約）。
			const target = join(outside.dir, "exported.md");
			await writeFile(target, "original", "utf8");
			await registerTransientWritePath(TEST_WIN, target);
			// 一度 write を通してから、target を別の外部 file への alias へ差し替える
			await writeFileImpl(TEST_WIN, target, "exported");
			await registerTransientWritePath(TEST_WIN, target);
			const other = join(outside.dir, "other.md");
			await writeFile(other, "other", "utf8");
			await rm(target);
			await symlink(other, target);

			await expect(writeFileImpl(TEST_WIN, target, "overwritten")).rejects.toMatchObject({
				kind: "PATH_OUTSIDE_WORKSPACE",
			});
			expect(await readFile(other, "utf8")).toBe("other");
			expect(getTransientWritePathsForWindow(TEST_WIN)).toHaveLength(1);
		});

		it("一度 write した path が workspace 内の alias へ retarget されたら解決先へ書く", async () => {
			const real = join(workspaceDir, "real.md");
			await writeFile(real, "before", "utf8");
			const path = join(workspaceDir, "note.md");
			await writeFile(path, "innocent", "utf8");
			await writeFileImpl(TEST_WIN, path, "innocent2");

			await rm(path);
			await symlink(real, path);

			await writeFileImpl(TEST_WIN, path, "after");
			expect(await readFile(real, "utf8")).toBe("after");
		});

		it("workspace 内の実体を指す alias への write は実体を更新する", async () => {
			const real = join(workspaceDir, "real.md");
			await writeFile(real, "before", "utf8");
			const alias = join(workspaceDir, "alias.md");
			await symlink(real, alias);

			await writeFileImpl(TEST_WIN, alias, "after");
			expect(await readFile(real, "utf8")).toBe("after");
		});

		it("上書き write は inode を保つ (#100 の直接書き込み契約)", async () => {
			// O_NOFOLLOW 化で tmp + rename に倒れていないことの pin。inode が変わると
			// symlink / hardlink / macOS xattr / 外部 watcher の前提が崩れる。
			const path = join(workspaceDir, "stable.md");
			await writeFile(path, "before", "utf8");
			const before = await stat(path);
			await writeFileImpl(TEST_WIN, path, "after");
			const after = await stat(path);
			expect(after.ino).toBe(before.ino);
			expect(await readFile(path, "utf8")).toBe("after");
		});
	});

	// 以下は O_NOFOLLOW を足さずに閉じている経路。「触っていないから安全」ではなく
	// open flag / syscall の semantics で閉じていることを pin する (fs.ts の doc と対応)。
	describe("O_NOFOLLOW 無しで閉じている経路", () => {
		it("create-file は dangling symlink 上で alreadyExists になる (wx = O_CREAT|O_EXCL)", async () => {
			const escapeTarget = join(outside.dir, "created-by-create.md");
			const link = join(workspaceDir, "new.md");
			await symlink(escapeTarget, link);

			await expect(createFileImpl(TEST_WIN, link)).rejects.toThrow(/already exists/i);
			await expect(stat(escapeTarget)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("write-new は dangling symlink 上で EEXIST になる", async () => {
			const escapeTarget = join(outside.dir, "created-by-write-new.md");
			const link = join(workspaceDir, "new2.md");
			await symlink(escapeTarget, link);

			await expect(writeNewFileImpl(TEST_WIN, link, "x")).rejects.toMatchObject({
				code: "EEXIST",
			});
			await expect(stat(escapeTarget)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("create-directory は dangling symlink 上で alreadyExists になる", async () => {
			const escapeTarget = join(outside.dir, "created-dir");
			const link = join(workspaceDir, "newdir");
			await symlink(escapeTarget, link);

			await expect(createDirectoryImpl(TEST_WIN, link)).rejects.toThrow(/already exists/i);
			await expect(stat(escapeTarget)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("rename の source が dangling symlink なら link 自体が移動する (#454)", async () => {
			const escapeTarget = join(outside.dir, "rename-source-target.md");
			const link = join(workspaceDir, "old.md");
			await symlink(escapeTarget, link);
			const renamed = join(workspaceDir, "renamed.md");

			// source の存在判定は entryExistsAt (lstat、no-follow) なので「解決先は無いが link は
			// 実在する」を正しく拾う。rename(2) も末端 symlink を辿らないため、移動するのは
			// link 自体であって解決先ではない。
			await renameEntryImpl(TEST_WIN, link, renamed);

			expect((await lstat(renamed)).isSymbolicLink()).toBe(true);
			expect(await readlink(renamed)).toBe(escapeTarget);
			await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(stat(escapeTarget)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("rename の target が dangling symlink なら Target already exists で止まる (#454)", async () => {
			const src = join(workspaceDir, "src.md");
			await writeFile(src, "body", "utf8");
			const escapeTarget = join(outside.dir, "rename-target.md");
			const link = join(workspaceDir, "dst.md");
			await symlink(escapeTarget, link);

			// target 側の判定も entryExistsAt なので、解決先の有無に関わらず entry が実在すれば
			// reject する。rename(2) が link を黙って置き換えてしまう前に止まる。
			await expect(renameEntryImpl(TEST_WIN, src, link)).rejects.toThrow(/^Target already exists:/);
			expect(await readlink(link)).toBe(escapeTarget);
			expect(await readFile(src, "utf8")).toBe("body");
			await expect(stat(escapeTarget)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("rename(2) 自体は末端 symlink を辿らず link を置き換える (target check 後のレース窓の根拠)", async () => {
			const src = join(workspaceDir, "race-src.md");
			await writeFile(src, "body", "utf8");
			const escapeTarget = join(outside.dir, "race-target.md");
			const link = join(workspaceDir, "race-dst.md");
			await symlink(escapeTarget, link);

			// renameEntryImpl 経由では #454 の target check に阻まれてここへは到達しない。
			// ただし check 通過後に外部プロセスが target へ symlink を置いた場合はこの syscall
			// semantics だけが escape を防ぐので、OS 側の性質として直接 pin しておく。
			await rename(src, link);

			expect(await readFile(link, "utf8")).toBe("body");
			await expect(stat(escapeTarget)).rejects.toMatchObject({ code: "ENOENT" });
		});
	});

	// #454: realpath が解決できない symlink (dangling / 循環) は canonical が link 自身の path に
	// なる。存在判定を entryExistsAt (lstat) にしたことで、これらを FileTree から削除できる。
	describe("解決できない symlink の削除 (#454)", () => {
		it("dangling symlink は link 自身が trashItem に渡る", async () => {
			const escapeTarget = join(outside.dir, "delete-dangling-target.md");
			const link = join(workspaceDir, "dangling.md");
			await symlink(escapeTarget, link);

			await deleteEntryImpl(TEST_WIN, link);

			// 値ではなく経路を観測する: 渡った path が link 自身であることと、解決先へは
			// 一切触れていないこと。
			expect(shell.trashItem).toHaveBeenCalledTimes(1);
			expect(shell.trashItem).toHaveBeenCalledWith(await canonicalize(link));
			await expect(stat(escapeTarget)).rejects.toMatchObject({ code: "ENOENT" });
		});

		it("自己参照する循環 symlink も削除できる", async () => {
			// realpath が失敗する path は dangling だけではない。循環も同じ経路を通る。
			const loop = join(workspaceDir, "loop.md");
			await symlink(loop, loop);

			await deleteEntryImpl(TEST_WIN, loop);

			expect(shell.trashItem).toHaveBeenCalledTimes(1);
			expect(shell.trashItem).toHaveBeenCalledWith(await canonicalize(loop));
		});

		it("path-exists / file-exists は従来どおり follow する (解決先を問う API)", async () => {
			const link = join(workspaceDir, "probe.md");
			await symlink(join(outside.dir, "probe-target.md"), link);
			const real = join(workspaceDir, "real-probe.md");
			await writeFile(real, "body", "utf8");
			const alias = join(workspaceDir, "alias-probe.md");
			await symlink(real, alias);

			// dangling は「解決先が無い」ので false。live な alias は実体が読めるので true。
			// alias 側の true は follow ではなく **canonical が realpath 済み**であることに由来する
			// （impl に届く時点で実体の path になっている）。follow / no-follow の差が観測できるのは
			// realpath が解決できない path だけで、pathExists を lstat 化すると dangling が true に
			// 転じ、「解決先が使えるか」という問いの答えとして誤る（mutation で確認済み）。
			expect(await pathExistsImpl(TEST_WIN, link)).toBe(false);
			expect(await fileExistsImpl(TEST_WIN, link)).toBe(false);
			expect(await pathExistsImpl(TEST_WIN, alias)).toBe(true);
			expect(await fileExistsImpl(TEST_WIN, alias)).toBe(true);
		});
	});
});
