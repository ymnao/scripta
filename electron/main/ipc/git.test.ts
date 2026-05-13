// @vitest-environment node
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
	BrowserWindow: { getAllWindows: () => [] },
}));

import { createGit } from "../utils/git-env";
import { clearWorkspaceRoots, registerWorkspaceRoot } from "../utils/path-guard";
import { __testing } from "./git";

const TEST_WIN = 1;
const OTHER_WIN = 2;

const {
	checkAvailableImpl,
	checkRepoImpl,
	statusImpl,
	addAllImpl,
	commitImpl,
	pullImpl,
	pushImpl,
	getConflictedFilesImpl,
	getConflictContentImpl,
	resolveConflictImpl,
	finishConflictResolutionImpl,
	getLastCommitTimeImpl,
	emitConflictResolvedImpl,
} = __testing;

// すべての test fixture を集約。temp dir を mkdtemp + realpath で正規化したうえで
// `git init` し、credential / sign 系を OFF にして teardown コストを下げる。
async function initRepo(): Promise<string> {
	const dir = await fsp.mkdtemp(join(tmpdir(), "scripta-git-test-"));
	const real = await fsp.realpath(dir);
	const git = createGit(real);
	// `-b main` は git 2.28+ 必須。CI runners は十分新しい。
	await git.raw(["init", "-b", "main"]);
	await git.raw(["config", "user.email", "test@test.com"]);
	await git.raw(["config", "user.name", "Test"]);
	await git.raw(["config", "commit.gpgsign", "false"]);
	return real;
}

async function commitFile(dir: string, name: string, content: string, msg: string): Promise<void> {
	await fsp.writeFile(join(dir, name), content, "utf8");
	const git = createGit(dir);
	await git.raw(["add", "--", name]);
	await git.raw(["commit", "-m", msg]);
}

// 同じファイルを main と branch-a で別内容にして merge 時に conflict させる。
async function makeMergeConflict(dir: string): Promise<string> {
	const git = createGit(dir);
	await commitFile(dir, "conflict.md", "base\n", "base");
	await git.raw(["checkout", "-b", "branch-a"]);
	await commitFile(dir, "conflict.md", "branch-a\n", "branch-a change");
	await git.raw(["checkout", "main"]);
	await commitFile(dir, "conflict.md", "main\n", "main change");
	// merge は conflict で非ゼロ exit する → catch して状態だけ返す
	try {
		await git.raw(["merge", "branch-a"]);
	} catch {
		// expected
	}
	return "conflict.md";
}

// 片側で変更、片側で削除し、merge で modify/delete conflict を発生させる。
async function makeModifyDeleteConflict(dir: string): Promise<string> {
	const git = createGit(dir);
	await commitFile(dir, "modify-delete.md", "base content\n", "base");
	await git.raw(["checkout", "-b", "branch-modify"]);
	await commitFile(dir, "modify-delete.md", "modified content\n", "modify");
	await git.raw(["checkout", "main"]);
	await git.raw(["rm", "--", "modify-delete.md"]);
	await git.raw(["commit", "-m", "delete"]);
	try {
		await git.raw(["merge", "branch-modify"]);
	} catch {
		// expected
	}
	return "modify-delete.md";
}

async function makeRebaseConflict(dir: string): Promise<string> {
	const git = createGit(dir);
	await commitFile(dir, "rebase.md", "base\n", "base");
	await git.raw(["checkout", "-b", "feature"]);
	await commitFile(dir, "rebase.md", "feature\n", "feature change");
	await git.raw(["checkout", "main"]);
	await commitFile(dir, "rebase.md", "main\n", "main change");
	await git.raw(["checkout", "feature"]);
	try {
		await git.raw(["rebase", "main"]);
	} catch {
		// expected
	}
	return "rebase.md";
}

// ローカル bare remote を作って upstream のあるリポジトリを構成。
async function setupRepoWithRemote(): Promise<{ work: string; remote: string }> {
	const remote = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "scripta-git-remote-")));
	await createGit(remote).raw(["init", "--bare", "-b", "main"]);
	const work = await initRepo();
	const wgit = createGit(work);
	await wgit.raw(["remote", "add", "origin", remote]);
	await commitFile(work, "first.md", "first\n", "first commit");
	return { work, remote };
}

let dirsToCleanup: string[] = [];

beforeEach(() => {
	clearWorkspaceRoots();
	dirsToCleanup = [];
});

afterEach(async () => {
	clearWorkspaceRoots();
	for (const d of dirsToCleanup) {
		await fsp.rm(d, { recursive: true, force: true });
	}
});

async function newWorkspace(): Promise<string> {
	const dir = await initRepo();
	dirsToCleanup.push(dir);
	registerWorkspaceRoot(TEST_WIN, dir);
	return dir;
}

describe("checkAvailableImpl", () => {
	it("returns true when git binary exists in PATH", async () => {
		expect(await checkAvailableImpl()).toBe(true);
	});
});

describe("checkRepoImpl", () => {
	it("returns true for a git-initialized directory", async () => {
		const dir = await newWorkspace();
		expect(await checkRepoImpl(TEST_WIN, dir)).toBe(true);
	});

	it("returns false for a non-repo directory (no throw)", async () => {
		const dir = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "scripta-git-test-")));
		dirsToCleanup.push(dir);
		registerWorkspaceRoot(TEST_WIN, dir);
		expect(await checkRepoImpl(TEST_WIN, dir)).toBe(false);
	});

	it("returns false for path outside workspace (no throw)", async () => {
		await newWorkspace();
		const outside = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "scripta-git-other-")));
		dirsToCleanup.push(outside);
		await createGit(outside).raw(["init", "-b", "main"]);
		// outside は TEST_WIN の allowedRoots に登録されていない → false
		expect(await checkRepoImpl(TEST_WIN, outside)).toBe(false);
	});
});

describe("statusImpl", () => {
	it("returns empty status for a fresh repo", async () => {
		const dir = await newWorkspace();
		const s = await statusImpl(TEST_WIN, dir);
		// HEAD が無い空 repo では branch は "HEAD" を返すこともあるので、空 or "main" を許容
		expect(s.changedFilesCount).toBe(0);
		expect(s.conflictFiles).toEqual([]);
		expect(s.hasRemote).toBe(false);
	});

	it("counts changed files via porcelain", async () => {
		const dir = await newWorkspace();
		await commitFile(dir, "a.md", "a\n", "init");
		await fsp.writeFile(join(dir, "b.md"), "b\n", "utf8");
		await fsp.writeFile(join(dir, "a.md"), "a-modified\n", "utf8");
		const s = await statusImpl(TEST_WIN, dir);
		expect(s.changedFilesCount).toBe(2);
	});

	it("detects remote when configured", async () => {
		const dir = await newWorkspace();
		// rev-parse --abbrev-ref HEAD は unborn branch では失敗するため、
		// branch 検出を確認するには 1 コミット必要。
		await commitFile(dir, "init.md", "init\n", "init");
		await createGit(dir).raw(["remote", "add", "origin", "https://example.com/x.git"]);
		const s = await statusImpl(TEST_WIN, dir);
		expect(s.hasRemote).toBe(true);
		expect(s.branch).toBe("main");
	});

	it("collects conflictFiles after a merge conflict", async () => {
		const dir = await newWorkspace();
		const file = await makeMergeConflict(dir);
		const s = await statusImpl(TEST_WIN, dir);
		expect(s.conflictFiles).toContain(file);
	});
});

describe("addAllImpl / commitImpl", () => {
	it("stages and commits all changes", async () => {
		const dir = await newWorkspace();
		await fsp.writeFile(join(dir, "x.md"), "x\n", "utf8");
		await addAllImpl(TEST_WIN, dir);
		await commitImpl(TEST_WIN, dir, "first");
		const log = await createGit(dir).raw(["log", "--oneline"]);
		expect(log.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
	});

	it("rejects nothing-to-commit (renderer マッチ用)", async () => {
		const dir = await newWorkspace();
		await commitFile(dir, "y.md", "y\n", "init");
		// 何も変更せずに commit → git が "nothing to commit" を返す
		await addAllImpl(TEST_WIN, dir);
		await expect(commitImpl(TEST_WIN, dir, "noop")).rejects.toThrow(/nothing to commit/i);
	});

	it("rejects path outside workspace", async () => {
		await newWorkspace();
		const outside = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "scripta-git-out-")));
		dirsToCleanup.push(outside);
		await expect(addAllImpl(TEST_WIN, outside)).rejects.toThrow(/Permission denied/);
	});
});

describe("pullImpl", () => {
	it("returns empty string for repo with no tracking info", async () => {
		const dir = await newWorkspace();
		await commitFile(dir, "z.md", "z\n", "init");
		// remote 無し / no upstream → 旧 Rust 互換で空文字列
		const result = await pullImpl(TEST_WIN, dir, "merge");
		expect(result).toBe("");
	});

	it("rejects invalid syncMethod", async () => {
		const dir = await newWorkspace();
		await expect(pullImpl(TEST_WIN, dir, "force")).rejects.toThrow(/Invalid sync_method/);
	});

	it("succeeds for fast-forward pull from a real local remote (merge)", async () => {
		const { work, remote } = await setupRepoWithRemote();
		dirsToCleanup.push(work, remote);
		registerWorkspaceRoot(TEST_WIN, work);
		const wgit = createGit(work);
		await wgit.raw(["push", "-u", "origin", "main"]);
		// 別 working clone から remote に commit を追加
		const other = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "scripta-git-other-")));
		dirsToCleanup.push(other);
		await createGit(other).raw(["clone", remote, other]);
		await createGit(other).raw(["config", "user.email", "test2@test.com"]);
		await createGit(other).raw(["config", "user.name", "Test2"]);
		await commitFile(other, "second.md", "second\n", "second");
		await createGit(other).raw(["push"]);
		// 元の work から pull
		await pullImpl(TEST_WIN, work, "merge");
		expect(
			await fsp.access(join(work, "second.md")).then(
				() => true,
				() => false,
			),
		).toBe(true);
	});

	it("supports rebase mode", async () => {
		const { work, remote } = await setupRepoWithRemote();
		dirsToCleanup.push(work, remote);
		registerWorkspaceRoot(TEST_WIN, work);
		await createGit(work).raw(["push", "-u", "origin", "main"]);
		// no-op rebase pull は成功するはず
		await pullImpl(TEST_WIN, work, "rebase");
	});
});

describe("pushImpl", () => {
	it("auto-retries with -u origin <branch> when no upstream is set", async () => {
		const { work, remote } = await setupRepoWithRemote();
		dirsToCleanup.push(work, remote);
		registerWorkspaceRoot(TEST_WIN, work);
		// upstream 未設定 → 自動 -u origin main で再試行 → 成功
		await pushImpl(TEST_WIN, work);
		// 再 push は upstream 済みなので普通に成功
		await commitFile(work, "second.md", "second\n", "second");
		const out = await pushImpl(TEST_WIN, work);
		// stdout か stderr が空でないことを確認（成功時の output は version 依存）
		expect(typeof out).toBe("string");
	});

	it("propagates network error stderr (renderer ネットワークパターン用)", async () => {
		const dir = await newWorkspace();
		await commitFile(dir, "n.md", "n\n", "init");
		// 127.0.0.1:1 は予約 port で確実に listen していない → 即時 ECONNREFUSED が返る
		// 旧版は `.invalid` TLD への DNS lookup を期待したが、resolver タイムアウトで flaky だった (#59)
		await createGit(dir).raw(["remote", "add", "origin", "http://127.0.0.1:1/x.git"]);
		await expect(pushImpl(TEST_WIN, dir)).rejects.toThrow(
			/could not resolve host|unable to access|connection refused|connection|network/i,
		);
	});
});

describe("getConflictedFilesImpl", () => {
	it("returns [] when no conflicts", async () => {
		const dir = await newWorkspace();
		await commitFile(dir, "a.md", "a\n", "init");
		expect(await getConflictedFilesImpl(TEST_WIN, dir)).toEqual([]);
	});

	it("returns relative paths during merge conflict", async () => {
		const dir = await newWorkspace();
		const file = await makeMergeConflict(dir);
		expect(await getConflictedFilesImpl(TEST_WIN, dir)).toEqual([file]);
	});
});

describe("getConflictContentImpl", () => {
	it("returns ours and theirs for a regular 3-way conflict", async () => {
		const dir = await newWorkspace();
		const file = await makeMergeConflict(dir);
		const c = await getConflictContentImpl(TEST_WIN, dir, file);
		expect(c.ours.trim()).toBe("main");
		expect(c.theirs.trim()).toBe("branch-a");
	});

	it("returns empty for missing stage in modify/delete conflict", async () => {
		const dir = await newWorkspace();
		const file = await makeModifyDeleteConflict(dir);
		const c = await getConflictContentImpl(TEST_WIN, dir, file);
		// main 側で削除 → ours (stage 2) が無い、theirs (stage 3) には modify 内容
		expect(c.ours).toBe("");
		expect(c.theirs.trim()).toBe("modified content");
	});

	it("rejects invalid filePath via validator", async () => {
		const dir = await newWorkspace();
		await expect(getConflictContentImpl(TEST_WIN, dir, "../escape.md")).rejects.toThrow(
			/must not contain/,
		);
		await expect(getConflictContentImpl(TEST_WIN, dir, "/etc/passwd")).rejects.toThrow(
			/must be relative/,
		);
	});
});

describe("resolveConflictImpl", () => {
	it('writes file and stages it for "modify"', async () => {
		const dir = await newWorkspace();
		const file = await makeMergeConflict(dir);
		await resolveConflictImpl(TEST_WIN, dir, file, "resolved\n", "modify");
		expect(await fsp.readFile(join(dir, file), "utf8")).toBe("resolved\n");
		// stage 0 にエントリが入る = `git diff --cached` で見える
		const cached = await createGit(dir).raw(["diff", "--cached", "--name-only"]);
		expect(cached.split("\n")).toContain(file);
	});

	it('removes file via git rm for "delete"', async () => {
		const dir = await newWorkspace();
		const file = await makeMergeConflict(dir);
		await resolveConflictImpl(TEST_WIN, dir, file, "", "delete");
		expect(
			await fsp.access(join(dir, file)).then(
				() => true,
				() => false,
			),
		).toBe(false);
	});

	it("rejects invalid resolution string", async () => {
		const dir = await newWorkspace();
		const file = await makeMergeConflict(dir);
		await expect(
			resolveConflictImpl(TEST_WIN, dir, file, "x", "force" as "modify"),
		).rejects.toThrow(/Invalid resolution/);
	});

	it("rejects path traversal via validator", async () => {
		const dir = await newWorkspace();
		await expect(resolveConflictImpl(TEST_WIN, dir, "../escape.md", "x", "modify")).rejects.toThrow(
			/must not contain/,
		);
	});

	it("rejects writing through a symlink target", async () => {
		const dir = await newWorkspace();
		await commitFile(dir, "real.md", "real\n", "init");
		await fsp.symlink(join(dir, "real.md"), join(dir, "link.md"));
		await expect(resolveConflictImpl(TEST_WIN, dir, "link.md", "x", "modify")).rejects.toThrow(
			/symbolic link/,
		);
	});
});

describe("finishConflictResolutionImpl", () => {
	it("commits via --no-edit after resolving merge conflict", async () => {
		const dir = await newWorkspace();
		const file = await makeMergeConflict(dir);
		await resolveConflictImpl(TEST_WIN, dir, file, "resolved\n", "modify");
		await finishConflictResolutionImpl(TEST_WIN, dir);
		// merge head が消え、最新 commit が増えていること
		const log = await createGit(dir).raw(["log", "--oneline"]);
		expect(log.split("\n").filter((l) => l.length > 0).length).toBeGreaterThan(1);
	});

	it("rebase --continue after resolving rebase conflict", async () => {
		const dir = await newWorkspace();
		const file = await makeRebaseConflict(dir);
		await resolveConflictImpl(TEST_WIN, dir, file, "resolved\n", "modify");
		await finishConflictResolutionImpl(TEST_WIN, dir);
		// rebase が完走して feature ブランチが進んでいること
		const branch = (await createGit(dir).raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
		expect(branch).toBe("feature");
	});

	it("does not hang when process.env GIT_EDITOR points to a blocking command", async () => {
		// ユーザーの開発環境では `EDITOR=vim` 等が設定されていることが多く、
		// `git rebase --continue` は default で commit message editor を起動するため、
		// GIT_ENV_OVERRIDES が GIT_EDITOR を no-op (`:`) に上書きしない限り
		// プロセスがハングする。`sleep 60` を envで指定しても 60 秒以内に
		// 完走できることで、override が effective に作用していることを担保する。
		vi.stubEnv("GIT_EDITOR", "sleep 60");
		try {
			const dir = await newWorkspace();
			const file = await makeRebaseConflict(dir);
			await resolveConflictImpl(TEST_WIN, dir, file, "resolved\n", "modify");
			await finishConflictResolutionImpl(TEST_WIN, dir);
			const branch = (await createGit(dir).raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
			expect(branch).toBe("feature");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("throws when not in merge or rebase state", async () => {
		const dir = await newWorkspace();
		await commitFile(dir, "z.md", "z\n", "init");
		await expect(finishConflictResolutionImpl(TEST_WIN, dir)).rejects.toThrow(
			/Not in a merge or rebase state/,
		);
	});
});

describe("getLastCommitTimeImpl", () => {
	it("returns null for empty repo", async () => {
		const dir = await newWorkspace();
		expect(await getLastCommitTimeImpl(TEST_WIN, dir)).toBeNull();
	});

	it("returns ISO 8601 timestamp for repo with commits", async () => {
		const dir = await newWorkspace();
		await commitFile(dir, "a.md", "a\n", "init");
		const t = await getLastCommitTimeImpl(TEST_WIN, dir);
		expect(t).not.toBeNull();
		// `%ci` は `YYYY-MM-DD HH:MM:SS +0900` 形式
		expect(t).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
	});

	it("returns null instead of throwing for path outside workspace", async () => {
		await newWorkspace();
		const outside = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "scripta-git-out-")));
		dirsToCleanup.push(outside);
		expect(await getLastCommitTimeImpl(TEST_WIN, outside)).toBeNull();
	});
});

describe("path-guard cross-cutting", () => {
	it("rejects each command for path outside parent's allowedRoots", async () => {
		await newWorkspace();
		const outside = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "scripta-git-other-")));
		dirsToCleanup.push(outside);
		await createGit(outside).raw(["init", "-b", "main"]);

		await expect(statusImpl(TEST_WIN, outside)).rejects.toThrow(/Permission denied/);
		await expect(commitImpl(TEST_WIN, outside, "x")).rejects.toThrow(/Permission denied/);
		await expect(pullImpl(TEST_WIN, outside, "merge")).rejects.toThrow(/Permission denied/);
		await expect(pushImpl(TEST_WIN, outside)).rejects.toThrow(/Permission denied/);
		await expect(getConflictedFilesImpl(TEST_WIN, outside)).rejects.toThrow(/Permission denied/);
		await expect(getConflictContentImpl(TEST_WIN, outside, "a.md")).rejects.toThrow(
			/Permission denied/,
		);
		await expect(resolveConflictImpl(TEST_WIN, outside, "a.md", "x", "modify")).rejects.toThrow(
			/Permission denied/,
		);
		await expect(finishConflictResolutionImpl(TEST_WIN, outside)).rejects.toThrow(
			/Permission denied/,
		);
	});

	it("rejects when called from a different window's id", async () => {
		const dir = await newWorkspace();
		await expect(statusImpl(OTHER_WIN, dir)).rejects.toThrow(/Permission denied/);
	});
});

describe("emitConflictResolvedImpl", () => {
	it("succeeds when sender's allowedRoots contains the workspace", async () => {
		const dir = await newWorkspace();
		// 正規経路: 自 window の allowedRoots に登録されている path → throw しない
		expect(() => emitConflictResolvedImpl(TEST_WIN, dir)).not.toThrow();
	});

	it("rejects emit for a workspace not in sender's allowedRoots", async () => {
		await newWorkspace();
		const outside = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "scripta-git-evict-")));
		dirsToCleanup.push(outside);
		// 別 window が偽装で他 workspace の path を流しても弾かれる
		expect(() => emitConflictResolvedImpl(TEST_WIN, outside)).toThrow(/Permission denied/);
	});

	it("rejects emit from a window that has no workspace registered", async () => {
		const dir = await newWorkspace();
		// OTHER_WIN は何も登録されていない window → 自 workspace でも弾かれる
		expect(() => emitConflictResolvedImpl(OTHER_WIN, dir)).toThrow(/Permission denied/);
	});
});
