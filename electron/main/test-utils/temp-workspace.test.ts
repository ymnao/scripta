// @vitest-environment node
import { realpath, rm, stat } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	createCanonicalTempWorkspace,
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
