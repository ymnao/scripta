// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type FsKind,
	isWatcherIgnored,
	mergeEventKind,
	reclassifyDeleted,
} from "../utils/watcher-pure";

describe("isWatcherIgnored", () => {
	const root = "/home/user/workspace";

	it("ignores `.git` directory and its descendants (performance hardcode)", () => {
		expect(isWatcherIgnored("/home/user/workspace/.git", root)).toBe(true);
		expect(isWatcherIgnored("/home/user/workspace/.git/HEAD", root)).toBe(true);
		expect(isWatcherIgnored("/home/user/workspace/.git/objects/abc", root)).toBe(true);
		// nested `.git` somewhere down the tree（submodule のようなケース）も除外
		expect(isWatcherIgnored("/home/user/workspace/sub/.git/config", root)).toBe(true);
	});

	it("does NOT ignore other hidden files / dirs (correctness — they must be watched)", () => {
		// 旧実装の `isHidden` はこれらも除外していたが、ユーザーが開いて編集する可能性がある
		// hidden path（`.gitignore` / `.scripta/scratchpads/*.md` 等）は監視対象。
		expect(isWatcherIgnored("/home/user/workspace/.gitignore", root)).toBe(false);
		expect(isWatcherIgnored("/home/user/workspace/.DS_Store", root)).toBe(false);
		expect(isWatcherIgnored("/home/user/workspace/.scripta", root)).toBe(false);
		expect(isWatcherIgnored("/home/user/workspace/.scripta/scratchpads/today.md", root)).toBe(
			false,
		);
		expect(isWatcherIgnored("/home/user/workspace/.env", root)).toBe(false);
	});

	it("does not ignore non-hidden paths", () => {
		expect(isWatcherIgnored("/home/user/workspace/notes/a.md", root)).toBe(false);
		expect(isWatcherIgnored("/home/user/workspace/README.md", root)).toBe(false);
	});

	it("does not ignore root itself or paths outside root (defensive)", () => {
		expect(isWatcherIgnored("/home/user/workspace", root)).toBe(false);
		expect(isWatcherIgnored("/etc/passwd", root)).toBe(false);
	});

	it("also ignores a path literally named `.git` (file/dir distinction is at path-component level)", () => {
		// 文字列レベルで path component を判定するため、`.git` という名前なら file/dir どちらでも
		// ignore 対象になる。git repo 内で `.git` という名前のファイルが発生するケースは
		// 通常ないため、過剰除外は実害なしと判断。
		expect(isWatcherIgnored("/home/user/workspace/.git", root)).toBe(true);
	});
});

describe("mergeEventKind", () => {
	let pending: Map<string, FsKind>;

	beforeEach(() => {
		pending = new Map();
	});

	it("create + modify keeps create", () => {
		mergeEventKind(pending, "/a.md", "create");
		mergeEventKind(pending, "/a.md", "modify");
		expect(pending.get("/a.md")).toBe("create");
	});

	it("create + delete removes the entry (net no-op)", () => {
		mergeEventKind(pending, "/a.md", "create");
		mergeEventKind(pending, "/a.md", "delete");
		expect(pending.has("/a.md")).toBe(false);
	});

	it("delete + create becomes modify (re-creation)", () => {
		mergeEventKind(pending, "/a.md", "delete");
		mergeEventKind(pending, "/a.md", "create");
		expect(pending.get("/a.md")).toBe("modify");
	});

	it("modify + delete becomes delete (latest wins)", () => {
		mergeEventKind(pending, "/a.md", "modify");
		mergeEventKind(pending, "/a.md", "delete");
		expect(pending.get("/a.md")).toBe("delete");
	});

	it("first event sets the kind", () => {
		mergeEventKind(pending, "/a.md", "modify");
		expect(pending.get("/a.md")).toBe("modify");
	});

	it("modify + modify keeps modify (overwrite is idempotent)", () => {
		mergeEventKind(pending, "/a.md", "modify");
		mergeEventKind(pending, "/a.md", "modify");
		expect(pending.get("/a.md")).toBe("modify");
	});

	it("multiple paths are tracked independently", () => {
		mergeEventKind(pending, "/a.md", "create");
		mergeEventKind(pending, "/b.md", "delete");
		expect(pending.get("/a.md")).toBe("create");
		expect(pending.get("/b.md")).toBe("delete");
	});
});

describe("reclassifyDeleted", () => {
	it("promotes modify to delete when path does not exist", () => {
		const pending = new Map<string, FsKind>([["/nonexistent/file.md", "modify"]]);
		reclassifyDeleted(pending, () => false);
		expect(pending.get("/nonexistent/file.md")).toBe("delete");
	});

	it("does not change modify when path exists", () => {
		const pending = new Map<string, FsKind>([["/exists.md", "modify"]]);
		reclassifyDeleted(pending, () => true);
		expect(pending.get("/exists.md")).toBe("modify");
	});

	it("does not promote create even when path does not exist", () => {
		const pending = new Map<string, FsKind>([["/transient.md", "create"]]);
		reclassifyDeleted(pending, () => false);
		expect(pending.get("/transient.md")).toBe("create");
	});

	it("does not touch delete entries", () => {
		const pending = new Map<string, FsKind>([["/gone.md", "delete"]]);
		reclassifyDeleted(pending, () => false);
		expect(pending.get("/gone.md")).toBe("delete");
	});

	it("uses real fs.existsSync as default", async () => {
		const dir = await mkdtemp(join(tmpdir(), "scripta-watcher-test-"));
		try {
			const real = join(dir, "exists.md");
			const ghost = join(dir, "ghost.md");
			await writeFile(real, "x", "utf8");
			const pending = new Map<string, FsKind>([
				[real, "modify"],
				[ghost, "modify"],
			]);
			reclassifyDeleted(pending);
			expect(pending.get(real)).toBe("modify");
			expect(pending.get(ghost)).toBe("delete");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("integrated merge + reclassify scenario", () => {
	it("create then modify is preserved as create even if reclassify runs after", () => {
		const pending = new Map<string, FsKind>();
		mergeEventKind(pending, "/x.md", "create");
		mergeEventKind(pending, "/x.md", "modify");
		// reclassifyDeleted は create を変えないので、create で残ること
		reclassifyDeleted(pending, () => false);
		expect(pending.get("/x.md")).toBe("create");
	});
});
