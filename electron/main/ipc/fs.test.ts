// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
	shell: {
		trashItem: vi.fn(async () => {}),
	},
}));

import { shell } from "electron";
import {
	clearWorkspaceRoots,
	getTransientWritePathsForWindow,
	registerTransientWritePath,
	registerWorkspaceRoot,
} from "../utils/path-guard";
import { __testing } from "./fs";

const TEST_WIN = 1;

const {
	readFileImpl,
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

beforeEach(async () => {
	clearWorkspaceRoots();
	workspaceDir = await mkdtemp(join(tmpdir(), "scripta-fs-test-"));
	registerWorkspaceRoot(workspaceDir);
	vi.mocked(shell.trashItem).mockClear();
});

afterEach(async () => {
	clearWorkspaceRoots();
	await rm(workspaceDir, { recursive: true, force: true });
});

describe("readFileImpl", () => {
	it("reads UTF-8 content from a file", async () => {
		const path = join(workspaceDir, "hello.md");
		await writeFile(path, "こんにちは\n世界", "utf8");
		expect(await readFileImpl(path)).toBe("こんにちは\n世界");
	});

	it("throws ENOENT when the file is missing", async () => {
		const path = join(workspaceDir, "missing.md");
		await expect(readFileImpl(path)).rejects.toThrow(/ENOENT/);
	});

	it("rejects relative paths", async () => {
		await expect(readFileImpl("relative.md")).rejects.toThrow(/Invalid path: must be absolute/);
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
		registerTransientWritePath(TEST_WIN, outside);
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
		const outsideDir = await mkdtemp(join(tmpdir(), "scripta-outside-dir-"));
		try {
			registerTransientWritePath(TEST_WIN, outsideDir);
			await expect(writeFileImpl(TEST_WIN, outsideDir, "x")).rejects.toThrow();
			// 失敗したので transient はまだ残っており、withRetry で再試行可能
			expect(getTransientWritePathsForWindow(TEST_WIN)).toHaveLength(1);
		} finally {
			await rm(outsideDir, { recursive: true, force: true });
		}
	});

	it("rejects when another window's transient is used (no cross-window leakage)", async () => {
		const outside = join(tmpdir(), `scripta-outside-cross-${Date.now()}.md`);
		const OTHER_WIN = 9999;
		registerTransientWritePath(OTHER_WIN, outside);
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
			registerTransientWritePath(TEST_WIN, outside);
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

		const entries = await listDirectoryImpl(workspaceDir);
		const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
		expect(sorted).toHaveLength(3);
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
		expect(await listDirectoryImpl(workspaceDir)).toEqual([]);
	});

	it("throws ENOENT for a missing directory", async () => {
		await expect(listDirectoryImpl(join(workspaceDir, "nope"))).rejects.toThrow(/ENOENT/);
	});
});

describe("createFileImpl", () => {
	it("creates an empty file", async () => {
		const path = join(workspaceDir, "new.md");
		await createFileImpl(path);
		expect(await readFile(path, "utf8")).toBe("");
	});

	it("creates parent directories", async () => {
		const path = join(workspaceDir, "deep", "x", "new.md");
		await createFileImpl(path);
		expect(await readFile(path, "utf8")).toBe("");
	});

	it("throws Already exists when the file is already present", async () => {
		const path = join(workspaceDir, "exists.md");
		await writeFile(path, "", "utf8");
		await expect(createFileImpl(path)).rejects.toThrow(/^Already exists:/);
	});

	it("rejects creation outside the workspace", async () => {
		const outside = join(tmpdir(), "scripta-outside-create.md");
		await expect(createFileImpl(outside)).rejects.toThrow(/Permission denied/);
	});
});

describe("createDirectoryImpl", () => {
	it("creates a new directory", async () => {
		const path = join(workspaceDir, "new-dir");
		await createDirectoryImpl(path);
		const s = await stat(path);
		expect(s.isDirectory()).toBe(true);
	});

	it("creates intermediate directories", async () => {
		const path = join(workspaceDir, "a", "b", "c");
		await createDirectoryImpl(path);
		const s = await stat(path);
		expect(s.isDirectory()).toBe(true);
	});

	it("throws Already exists when the directory exists", async () => {
		const path = join(workspaceDir, "dir");
		await createDirectoryImpl(path);
		await expect(createDirectoryImpl(path)).rejects.toThrow(/^Already exists:/);
	});
});

describe("pathExistsImpl / fileExistsImpl", () => {
	it("pathExists returns true for an existing file", async () => {
		const path = join(workspaceDir, "f.md");
		await writeFile(path, "", "utf8");
		expect(await pathExistsImpl(path)).toBe(true);
	});

	it("pathExists returns true for an existing directory", async () => {
		expect(await pathExistsImpl(workspaceDir)).toBe(true);
	});

	it("pathExists returns false for a missing entry", async () => {
		expect(await pathExistsImpl(join(workspaceDir, "missing"))).toBe(false);
	});

	it("fileExists returns true only for files (not directories)", async () => {
		const path = join(workspaceDir, "file.md");
		await writeFile(path, "", "utf8");
		expect(await fileExistsImpl(path)).toBe(true);
		expect(await fileExistsImpl(workspaceDir)).toBe(false);
	});

	it("fileExists returns false when missing", async () => {
		expect(await fileExistsImpl(join(workspaceDir, "missing.md"))).toBe(false);
	});
});

describe("renameEntryImpl", () => {
	it("renames a file", async () => {
		const oldPath = join(workspaceDir, "old.md");
		const newPath = join(workspaceDir, "new.md");
		await writeFile(oldPath, "content", "utf8");
		await renameEntryImpl(oldPath, newPath);
		expect(await pathExistsImpl(oldPath)).toBe(false);
		expect(await readFile(newPath, "utf8")).toBe("content");
	});

	it("creates the destination's parent directory if missing", async () => {
		const oldPath = join(workspaceDir, "old.md");
		const newPath = join(workspaceDir, "moved", "deep", "new.md");
		await writeFile(oldPath, "x", "utf8");
		await renameEntryImpl(oldPath, newPath);
		expect(await readFile(newPath, "utf8")).toBe("x");
	});

	it("throws Source not found when missing", async () => {
		const oldPath = join(workspaceDir, "missing.md");
		const newPath = join(workspaceDir, "new.md");
		await expect(renameEntryImpl(oldPath, newPath)).rejects.toThrow(/^Source not found:/);
	});

	it("throws Target already exists when destination exists", async () => {
		const oldPath = join(workspaceDir, "old.md");
		const newPath = join(workspaceDir, "new.md");
		await writeFile(oldPath, "a", "utf8");
		await writeFile(newPath, "b", "utf8");
		await expect(renameEntryImpl(oldPath, newPath)).rejects.toThrow(/^Target already exists:/);
	});

	it("rejects when either side is outside the workspace", async () => {
		const inside = join(workspaceDir, "f.md");
		await writeFile(inside, "", "utf8");
		const outside = join(tmpdir(), "scripta-outside-rename.md");
		await expect(renameEntryImpl(inside, outside)).rejects.toThrow(/Permission denied/);
		await expect(renameEntryImpl(outside, inside)).rejects.toThrow(/Permission denied/);
	});
});

describe("deleteEntryImpl", () => {
	it("calls shell.trashItem for an existing file", async () => {
		const path = join(workspaceDir, "f.md");
		await writeFile(path, "", "utf8");
		await deleteEntryImpl(path);
		expect(shell.trashItem).toHaveBeenCalledTimes(1);
		expect(shell.trashItem).toHaveBeenCalledWith(path);
	});

	it("throws Not found for missing entries", async () => {
		const path = join(workspaceDir, "missing.md");
		await expect(deleteEntryImpl(path)).rejects.toThrow(/^Not found:/);
		expect(shell.trashItem).not.toHaveBeenCalled();
	});

	it("rejects deletes outside the workspace", async () => {
		const outside = join(tmpdir(), "scripta-outside-delete.md");
		await writeFile(outside, "", "utf8").catch(() => {});
		await expect(deleteEntryImpl(outside)).rejects.toThrow(/Permission denied/);
		await rm(outside, { force: true });
	});
});
