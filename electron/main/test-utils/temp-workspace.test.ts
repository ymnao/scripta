// @vitest-environment node
import { lstatSync } from "node:fs";
import { realpath, rm, stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	createCanonicalTempWorkspace,
	createSymlinkedWorkspace,
	createTempWorkspace,
	makeCanonicalTempDir,
	makeTempDir,
} from "./temp-workspace";

describe("createTempWorkspace", () => {
	const created: Array<{ cleanup: () => Promise<void> }> = [];

	afterEach(async () => {
		await Promise.all(created.splice(0).map((ws) => ws.cleanup().catch(() => {})));
	});

	it("creates a directory under tmpdir with the given prefix", async () => {
		const ws = await createTempWorkspace("scripta-temp-helper-test-");
		created.push(ws);
		expect(ws.dir).toMatch(/scripta-temp-helper-test-/);
		expect((await stat(ws.dir)).isDirectory()).toBe(true);
	});

	it("cleanup removes the directory recursively", async () => {
		const ws = await createTempWorkspace("scripta-temp-helper-cleanup-");
		await ws.cleanup();
		await expect(stat(ws.dir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("cleanup is idempotent (force=true swallows ENOENT)", async () => {
		const ws = await createTempWorkspace("scripta-temp-helper-idem-");
		await ws.cleanup();
		await expect(ws.cleanup()).resolves.toBeUndefined();
	});
});

describe("createCanonicalTempWorkspace", () => {
	const created: Array<{ cleanup: () => Promise<void> }> = [];

	afterEach(async () => {
		await Promise.all(created.splice(0).map((ws) => ws.cleanup().catch(() => {})));
	});

	it("returns a path that is its own realpath (canonical)", async () => {
		const ws = await createCanonicalTempWorkspace("scripta-canon-helper-test-");
		created.push(ws);
		expect(await realpath(ws.dir)).toBe(ws.dir);
	});

	it("cleanup removes the directory recursively", async () => {
		const ws = await createCanonicalTempWorkspace("scripta-canon-helper-cleanup-");
		await ws.cleanup();
		await expect(stat(ws.dir)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("makeTempDir / makeCanonicalTempDir", () => {
	const created: string[] = [];

	afterEach(async () => {
		await Promise.all(
			created.splice(0).map((d) => rm(d, { recursive: true, force: true }).catch(() => {})),
		);
	});

	it("makeTempDir creates a directory and returns its path", async () => {
		const dir = await makeTempDir("scripta-make-helper-test-");
		created.push(dir);
		expect((await stat(dir)).isDirectory()).toBe(true);
	});

	it("makeCanonicalTempDir returns a realpath-resolved path", async () => {
		const dir = await makeCanonicalTempDir("scripta-make-canon-helper-test-");
		created.push(dir);
		expect(await realpath(dir)).toBe(dir);
	});
});

describe.skipIf(process.platform === "win32")("createSymlinkedWorkspace", () => {
	const created: Array<{ cleanup: () => Promise<void> }> = [];

	afterEach(async () => {
		await Promise.all(created.splice(0).map((ws) => ws.cleanup().catch(() => {})));
	});

	it("creates realDir, canonicalRealDir, and a symlink pointing to realDir", async () => {
		const ws = await createSymlinkedWorkspace("scripta-symlink-helper-real-");
		created.push(ws);
		// realDir は実ディレクトリ
		expect((await stat(ws.realDir)).isDirectory()).toBe(true);
		// canonicalRealDir は realpath が冪等になる
		expect(await realpath(ws.realDir)).toBe(ws.canonicalRealDir);
		// symlinkDir は symlink
		expect(lstatSync(ws.symlinkDir).isSymbolicLink()).toBe(true);
		// symlink 経由で見ると realDir と同じ canonical を指す
		expect(await realpath(ws.symlinkDir)).toBe(ws.canonicalRealDir);
	});

	it("cleanup removes both symlink and realDir", async () => {
		const ws = await createSymlinkedWorkspace("scripta-symlink-helper-cleanup-");
		await ws.cleanup();
		await expect(stat(ws.realDir)).rejects.toMatchObject({ code: "ENOENT" });
		expect(() => lstatSync(ws.symlinkDir)).toThrow(/ENOENT/);
	});

	it("cleanup is best-effort for the symlink (still removes realDir if symlink is already gone)", async () => {
		const ws = await createSymlinkedWorkspace("scripta-symlink-helper-best-effort-");
		// 事前に symlink を消しておく
		const { unlinkSync } = await import("node:fs");
		unlinkSync(ws.symlinkDir);
		// cleanup は throw せず realDir を消す
		await expect(ws.cleanup()).resolves.toBeUndefined();
		await expect(stat(ws.realDir)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
