// @vitest-environment node
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertReadAllowed,
	assertWriteAllowed,
	clearWorkspaceRoots,
	getWorkspaceRoots,
	isReadAllowed,
	isWriteAllowed,
	registerWorkspaceRoot,
	unregisterWorkspaceRoot,
	validatePath,
} from "./path-guard";

let workspaceDir = "";
let outsideDir = "";

beforeEach(async () => {
	clearWorkspaceRoots();
	workspaceDir = await mkdtemp(join(tmpdir(), "scripta-pg-ws-"));
	outsideDir = await mkdtemp(join(tmpdir(), "scripta-pg-out-"));
});

afterEach(async () => {
	clearWorkspaceRoots();
	await rm(workspaceDir, { recursive: true, force: true });
	await rm(outsideDir, { recursive: true, force: true });
});

describe("validatePath", () => {
	it("returns absolute paths after normalization", () => {
		expect(validatePath("/tmp/test.md")).toBe("/tmp/test.md");
	});

	it("normalizes parent-traversal segments", () => {
		expect(validatePath("/tmp/foo/../bar/test.md")).toBe("/tmp/bar/test.md");
	});

	it("normalizes redundant separators", () => {
		expect(validatePath("/tmp//foo/./bar")).toBe("/tmp/foo/bar");
	});

	it("rejects empty string", () => {
		expect(() => validatePath("")).toThrow(/Invalid path: empty/);
	});

	it("rejects relative paths", () => {
		expect(() => validatePath("relative/path.md")).toThrow(/Invalid path: must be absolute/);
	});

	it("rejects paths containing null bytes", () => {
		expect(() => validatePath("/tmp/\0evil")).toThrow(/Invalid path: null byte/);
	});
});

describe("workspace root registration", () => {
	it("registers and lists realpath-resolved roots", () => {
		registerWorkspaceRoot(workspaceDir);
		const roots = getWorkspaceRoots();
		expect(roots).toHaveLength(1);
		// macOS では /var → /private/var など symlink が解消される。
		// その対称性を確かめるためには realpath したパスの末尾が workspaceDir の末尾と一致することで十分。
		expect(roots[0].endsWith(workspaceDir.split("/").slice(-1)[0])).toBe(true);
	});

	it("unregisters a realpath-resolved root", () => {
		registerWorkspaceRoot(workspaceDir);
		unregisterWorkspaceRoot(workspaceDir);
		expect(getWorkspaceRoots()).toEqual([]);
	});

	it("clears all roots", () => {
		registerWorkspaceRoot(workspaceDir);
		clearWorkspaceRoots();
		expect(getWorkspaceRoots()).toEqual([]);
	});

	it("registers non-existent paths by falling back to resolve()", () => {
		const phantom = "/this/path/does/not/exist";
		registerWorkspaceRoot(phantom);
		expect(getWorkspaceRoots()).toEqual([phantom]);
	});
});

describe("isReadAllowed / isWriteAllowed", () => {
	it("allows everything when no roots are registered (back-compat)", () => {
		expect(isReadAllowed("/anywhere/file")).toBe(true);
		expect(isWriteAllowed("/anywhere/file")).toBe(true);
	});

	it("allows reads of files inside the workspace", async () => {
		const file = join(workspaceDir, "f.md");
		await writeFile(file, "x", "utf8");
		registerWorkspaceRoot(workspaceDir);
		expect(isReadAllowed(file)).toBe(true);
	});

	it("rejects reads of files outside the workspace", async () => {
		const outsideFile = join(outsideDir, "secret");
		await writeFile(outsideFile, "x", "utf8");
		registerWorkspaceRoot(workspaceDir);
		expect(isReadAllowed(outsideFile)).toBe(false);
	});

	it("blocks symlink-based escape from the workspace (read)", async () => {
		// workspace 内に outside ディレクトリを指す symlink を仕込む
		const link = join(workspaceDir, "escape");
		await symlink(outsideDir, link);
		const target = join(link, "secret");
		await writeFile(target, "leaked", "utf8");
		registerWorkspaceRoot(workspaceDir);
		// 単純な path.resolve では「workspace 内」と判定されてしまうが、
		// realpath ベースの判定では outside に解決されるため拒否される
		expect(isReadAllowed(target)).toBe(false);
	});

	it("allows writes inside the workspace even before the file exists", () => {
		registerWorkspaceRoot(workspaceDir);
		const newPath = join(workspaceDir, "subdir", "new.md");
		expect(isWriteAllowed(newPath)).toBe(true);
	});

	it("blocks symlink-based escape on writes (parent dir is realpath'd)", async () => {
		const link = join(workspaceDir, "escape");
		await symlink(outsideDir, link);
		registerWorkspaceRoot(workspaceDir);
		const evil = join(link, "new-file.md");
		expect(isWriteAllowed(evil)).toBe(false);
	});

	it("allows writes inside any of multiple registered roots", async () => {
		const second = await mkdtemp(join(tmpdir(), "scripta-pg-ws2-"));
		try {
			registerWorkspaceRoot(workspaceDir);
			registerWorkspaceRoot(second);
			expect(isWriteAllowed(join(workspaceDir, "a.md"))).toBe(true);
			expect(isWriteAllowed(join(second, "b.md"))).toBe(true);
			expect(isWriteAllowed(join(outsideDir, "c.md"))).toBe(false);
		} finally {
			await rm(second, { recursive: true, force: true });
		}
	});

	it("does not falsely match sibling directories sharing a name prefix", async () => {
		const sibling = await mkdtemp(join(tmpdir(), "scripta-pg-ws-"));
		try {
			registerWorkspaceRoot(workspaceDir);
			expect(isReadAllowed(join(sibling, "f.md"))).toBe(false);
		} finally {
			await rm(sibling, { recursive: true, force: true });
		}
	});
});

describe("assertReadAllowed / assertWriteAllowed", () => {
	it("does not throw inside the workspace", async () => {
		const file = join(workspaceDir, "f.md");
		await writeFile(file, "x", "utf8");
		registerWorkspaceRoot(workspaceDir);
		expect(() => assertReadAllowed(file)).not.toThrow();
		expect(() => assertWriteAllowed(join(workspaceDir, "new.md"))).not.toThrow();
	});

	it("throws a generic Permission denied error WITHOUT leaking the path", async () => {
		registerWorkspaceRoot(workspaceDir);
		const offendingPath = join(outsideDir, "secret");
		expect(() => assertReadAllowed(offendingPath)).toThrow(
			/^Permission denied: outside workspace$/,
		);
		// 違反パスが Error.message に含まれていないことを明示的に検証
		try {
			assertReadAllowed(offendingPath);
		} catch (e) {
			expect((e as Error).message).not.toContain(offendingPath);
			expect((e as Error).message).not.toContain(outsideDir);
		}
	});

	it("logs the offending path to console.warn but not to the thrown Error", async () => {
		registerWorkspaceRoot(workspaceDir);
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(() => assertWriteAllowed(join(outsideDir, "x"))).toThrow();
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0][0]).toContain("[path-guard]");
			expect(spy.mock.calls[0][0]).toContain(outsideDir);
		} finally {
			spy.mockRestore();
		}
	});
});
