// @vitest-environment node
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
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
	readFileImpl,
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
