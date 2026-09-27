// @vitest-environment node
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeCanonicalTempDir } from "../test-utils/temp-workspace";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
	BrowserWindow: { getAllWindows: () => [] },
}));

import { ipcMain } from "electron";
import { isNetworkError } from "../../../src/lib/errors";
import { createGit } from "../utils/git-env";
import { clearWorkspaceRoots, registerWorkspaceRoot } from "../utils/path-guard";
import { __testing, registerGitIpc } from "./git";
import {
	acquireFileListCache,
	getCachedMdFiles,
	getContentCacheHandle,
	populateFileListCache,
	releaseFileListCache,
} from "./search-cache";

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
	const real = await makeCanonicalTempDir("scripta-git-test-");
	const git = createGit(real);
	// `-b main` は git 2.28+ 必須。CI runners は十分新しい。
	await git.raw(["init", "-b", "main"]);
	await git.raw(["config", "user.email", "test@test.com"]);
	await git.raw(["config", "user.name", "Test"]);
	await git.raw(["config", "commit.gpgsign", "false"]);
	// `syncMethod: "merge"` の test が実際に merge を走るようにする。global config を遮断した
	// 状態（beforeEach）では `pull.rebase` が未設定になり、divergent な pull は merge を試す前に
	// 「どちらで reconcile するか指定せよ」で中断するため、working tree に marker が書かれない。
	await git.raw(["config", "pull.rebase", "false"]);
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
	const remote = await makeCanonicalTempDir("scripta-git-remote-");
	await createGit(remote).raw(["init", "--bare", "-b", "main"]);
	const work = await initRepo();
	const wgit = createGit(work);
	await wgit.raw(["remote", "add", "origin", remote]);
	await commitFile(work, "first.md", "first\n", "first commit");
	return { work, remote };
}

let dirsToCleanup: string[] = [];

// 開発者の global / system git config を scope ごと遮断する（git 2.32+）。`pull.rebase=true` が
// 漏れると `syncMethod: "merge"` を渡した test が実際には rebase 経路を走り、「merge conflict では
// HEAD が動かない」前提を pin したい test が HEAD が動く経路を観測して mutant を見逃す（実際に
// `--cached` 削除の mutant が survive した）。キー単位で repo-local に上書きすると次に別キーで
// 同じことが起きるので、repo-local 以外の scope 自体を読ませない。
beforeEach(() => {
	vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
	vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
	clearWorkspaceRoots();
	dirsToCleanup = [];
});

afterEach(async () => {
	clearWorkspaceRoots();
	for (const d of dirsToCleanup) {
		// git のバックグラウンド書き込み（pack 生成等）と削除がレースすると
		// `.git/objects/pack` で ENOTEMPTY が出る。fsp.rm は maxRetries 指定時に
		// ENOTEMPTY / EBUSY 等を指数バックオフで自動リトライするため、CI の
		// flaky cleanup を防ぐ。
		await fsp.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
	vi.unstubAllEnvs();
});

async function newWorkspace(): Promise<string> {
	const dir = await initRepo();
	dirsToCleanup.push(dir);
	await registerWorkspaceRoot(TEST_WIN, dir);
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
		const dir = await makeCanonicalTempDir("scripta-git-test-");
		dirsToCleanup.push(dir);
		await registerWorkspaceRoot(TEST_WIN, dir);
		expect(await checkRepoImpl(TEST_WIN, dir)).toBe(false);
	});

	it("returns false for path outside workspace (no throw)", async () => {
		await newWorkspace();
		const outside = await makeCanonicalTempDir("scripta-git-other-");
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

	it("rejects nothing-to-commit (kind=GIT_NOTHING_TO_COMMIT)", async () => {
		const dir = await newWorkspace();
		await commitFile(dir, "y.md", "y\n", "init");
		// 何も変更せずに commit → git が "nothing to commit" を返す
		await addAllImpl(TEST_WIN, dir);
		// 余計な git プロセスを増やさないよう、エラーを 1 回だけ捕捉して
		// message（renderer 互換）と kind の両方を検証する。
		const err = await commitImpl(TEST_WIN, dir, "noop").catch((e: unknown) => e);
		expect((err as Error).message).toMatch(/nothing to commit/i);
		expect(err).toMatchObject({ kind: "GIT_NOTHING_TO_COMMIT" });
	});

	it("rejects path outside workspace", async () => {
		await newWorkspace();
		const outside = await makeCanonicalTempDir("scripta-git-out-");
		dirsToCleanup.push(outside);
		await expect(addAllImpl(TEST_WIN, outside)).rejects.toThrow(/Permission denied/);
	});
});

describe("pullImpl", () => {
	it("returns empty string for repo with no tracking info", async () => {
		const dir = await newWorkspace();
		await commitFile(dir, "z.md", "z\n", "init");
		// remote 無し / no upstream → 空文字列を返す契約
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
		await registerWorkspaceRoot(TEST_WIN, work);
		const wgit = createGit(work);
		await wgit.raw(["push", "-u", "origin", "main"]);
		// 別 working clone から remote に commit を追加
		const other = await makeCanonicalTempDir("scripta-git-other-");
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
		await registerWorkspaceRoot(TEST_WIN, work);
		await createGit(work).raw(["push", "-u", "origin", "main"]);
		// no-op rebase pull は成功するはず
		await pullImpl(TEST_WIN, work, "rebase");
	});
});

describe("pushImpl", () => {
	it("auto-retries with -u origin <branch> when no upstream is set", async () => {
		const { work, remote } = await setupRepoWithRemote();
		dirsToCleanup.push(work, remote);
		await registerWorkspaceRoot(TEST_WIN, work);
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
		// 127.0.0.1:1 は通常 listen されない低番 port のため即時 ECONNREFUSED が期待される。
		// createGit は process.env を継承するため、proxy 環境変数があると proxy 経由になり
		// 挙動が変わる。本テスト中だけ unset して決定論性を保つ。
		const proxyKeys = [
			"http_proxy",
			"https_proxy",
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"all_proxy",
			"ALL_PROXY",
		];
		const savedProxy = Object.fromEntries(proxyKeys.map((k) => [k, process.env[k]]));
		for (const k of proxyKeys) delete process.env[k];
		try {
			await createGit(dir).raw(["remote", "add", "origin", "https://127.0.0.1:1/x.git"]);
			// renderer 側 isNetworkError と同じ判定を使うことで、テストの意図
			// (network error の stderr が renderer の判定にかかること) と一致させる。
			// `unable to access` 単独などの非ネットワーク原因が誤検知されない。
			const err = await pushImpl(TEST_WIN, dir).then(
				() => {
					throw new Error("expected pushImpl to reject");
				},
				(e: unknown) => e,
			);
			expect(isNetworkError(err), `unexpected error: ${(err as Error)?.message}`).toBe(true);
		} finally {
			for (const [k, v] of Object.entries(savedProxy)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
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

	it('evicts the L2 ContentCache entry for the written file on "modify" (#397)', async () => {
		const dir = await newWorkspace();
		const file = await makeMergeConflict(dir);
		const canonicalRoot = await fsp.realpath(dir);
		acquireFileListCache(canonicalRoot);
		try {
			const cache = getContentCacheHandle(canonicalRoot);
			const target = join(canonicalRoot, file);
			cache?.set(target, "stale", cache.generation);
			expect(cache?.get(target)).toBe("stale");

			await resolveConflictImpl(TEST_WIN, dir, file, "resolved\n", "modify");

			expect(cache?.get(target)).toBeUndefined();
		} finally {
			releaseFileListCache(canonicalRoot);
		}
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

	it('evicts the L2 ContentCache entry for the removed file on "delete" (#397)', async () => {
		const dir = await newWorkspace();
		const file = await makeMergeConflict(dir);
		const canonicalRoot = await fsp.realpath(dir);
		acquireFileListCache(canonicalRoot);
		try {
			const cache = getContentCacheHandle(canonicalRoot);
			const target = join(canonicalRoot, file);
			cache?.set(target, "stale", cache.generation);
			expect(cache?.get(target)).toBe("stale");

			await resolveConflictImpl(TEST_WIN, dir, file, "", "delete");

			expect(cache?.get(target)).toBeUndefined();
		} finally {
			releaseFileListCache(canonicalRoot);
		}
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

	// `/symbolic link/` の正規表現では **ELOOP の生メッセージ** (`too many symbolic links
	// encountered`) にも一致してしまい、「main 側で文言に正規化している」ことを pin できない
	// (mutation 検証で実際に生き残った)。#455 の test は全文で固定する (`toThrow(string)` は
	// 部分一致だが、生 ELOOP message はこの全文を含まないので判別力がある)。
	const SYMLINK_REFUSAL = "file_path is a symbolic link; refusing to write";

	// #455: 末端が workspace 外を指す symlink のケース。上の test は「拒否されること」しか
	// 見ないので、escape の実体 (外部 file の書き換え) が起きていないことをここで pin する。
	it.skipIf(process.platform === "win32")(
		"does not write through a symlink pointing outside the workspace",
		async () => {
			const dir = await newWorkspace();
			const outside = await makeCanonicalTempDir("scripta-git-victim-");
			dirsToCleanup.push(outside);
			const victim = join(outside, "victim.md");
			await fsp.writeFile(victim, "ORIGINAL", "utf8");
			await fsp.symlink(victim, join(dir, "link.md"));

			await expect(
				resolveConflictImpl(TEST_WIN, dir, "link.md", "PWNED", "modify"),
			).rejects.toThrow(SYMLINK_REFUSAL);
			expect(await fsp.readFile(victim, "utf8")).toBe("ORIGINAL");
		},
	);

	// #455: lstat 検査と write の間に swap される窓を pin する。lstat が「symlink ではない」と
	// 答えた直後に symlink が現れる状況を、lstat を 1 度だけ差し替えて決定的に作る。
	// `O_NOFOLLOW` write が無いとここで外部の実体が書き換わる (win32 は flag が 0 に落ちるため
	// この層は効かない = #451 のスコープなので skip)。
	it.skipIf(process.platform === "win32")(
		"does not write through a symlink swapped in after the lstat check",
		async () => {
			const dir = await newWorkspace();
			const outside = await makeCanonicalTempDir("scripta-git-victim-swap-");
			dirsToCleanup.push(outside);
			const victim = join(outside, "victim.md");
			await fsp.writeFile(victim, "ORIGINAL", "utf8");
			const target = join(dir, "swapped.md");

			const lstatSpy = vi.spyOn(fsp, "lstat").mockImplementationOnce(async () => {
				// 検査を通した「直後」に swap されたことにする。
				await fsp.symlink(victim, target);
				return { isSymbolicLink: () => false } as Awaited<ReturnType<typeof fsp.lstat>>;
			});
			try {
				await expect(
					resolveConflictImpl(TEST_WIN, dir, "swapped.md", "PWNED", "modify"),
				).rejects.toThrow(SYMLINK_REFUSAL);
				expect(await fsp.readFile(victim, "utf8")).toBe("ORIGINAL");
			} finally {
				lstatSpy.mockRestore();
			}
		},
	);
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
		const outside = await makeCanonicalTempDir("scripta-git-out-");
		dirsToCleanup.push(outside);
		expect(await getLastCommitTimeImpl(TEST_WIN, outside)).toBeNull();
	});
});

describe("path-guard cross-cutting", () => {
	it("rejects each command for path outside parent's allowedRoots", async () => {
		await newWorkspace();
		const outside = await makeCanonicalTempDir("scripta-git-other-");
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
		await expect(emitConflictResolvedImpl(TEST_WIN, dir)).resolves.not.toThrow();
	});

	it("rejects emit for a workspace not in sender's allowedRoots", async () => {
		await newWorkspace();
		const outside = await makeCanonicalTempDir("scripta-git-evict-");
		dirsToCleanup.push(outside);
		// 別 window が偽装で他 workspace の path を流しても弾かれる
		await expect(emitConflictResolvedImpl(TEST_WIN, outside)).rejects.toThrow(/Permission denied/);
	});

	it("rejects emit from a window that has no workspace registered", async () => {
		const dir = await newWorkspace();
		// OTHER_WIN は何も登録されていない window → 自 workspace でも弾かれる
		await expect(emitConflictResolvedImpl(OTHER_WIN, dir)).rejects.toThrow(/Permission denied/);
	});
});

describe("git:emit-conflict-resolved IPC ハンドラ配線", () => {
	it("ハンドラが impl の Promise を返し、認可エラーが呼び出し元へ伝播する", async () => {
		vi.mocked(ipcMain.handle).mockReset();
		registerGitIpc();

		const calls = vi.mocked(ipcMain.handle).mock.calls;
		const entry = calls.find(([ch]) => ch === "git:emit-conflict-resolved");
		if (!entry) throw new Error("git:emit-conflict-resolved was not registered");
		const listener = entry[1];

		// 修正前はハンドラが Promise を捨てて undefined を返し、認可エラーを隠蔽していた（その回帰防止）。
		// 未登録 window からの emit は path のみで reject するため、git repo は不要（mkdtemp のみ）。
		const event = { sender: { id: OTHER_WIN } } as unknown as IpcMainInvokeEvent;
		const dir = await makeCanonicalTempDir("scripta-git-wiring-");
		dirsToCleanup.push(dir);
		await expect(listener(event, dir)).rejects.toThrow(/Permission denied/);
	});
});

// git 子プロセスが書き換えた working tree を watcher flush (500ms) より先に search-cache へ
// 反映することの pin (#569)。L1 は getCachedMdFiles で直接観測する (検索結果経由だと
// 消えた file が read 失敗で skip され vacuous pass する)。
describe("git working tree writes: proactive search-cache invalidation (#569)", () => {
	// remote を clone した別 working copy で mutate して push する。
	async function pushFromOtherClone(
		remote: string,
		mutate: (dir: string) => Promise<void>,
	): Promise<void> {
		const other = await makeCanonicalTempDir("scripta-git-other-");
		dirsToCleanup.push(other);
		const ogit = createGit(other);
		await ogit.raw(["clone", remote, other]);
		await ogit.raw(["config", "user.email", "test2@test.com"]);
		await ogit.raw(["config", "user.name", "Test2"]);
		await ogit.raw(["config", "commit.gpgsign", "false"]);
		await mutate(other);
		await ogit.raw(["push"]);
	}

	// upstream 追従済みの work repo (first.md を 1 commit 持つ)。
	async function setupPullable(): Promise<{ work: string; remote: string; canonicalRoot: string }> {
		const { work, remote } = await setupRepoWithRemote();
		dirsToCleanup.push(work, remote);
		await registerWorkspaceRoot(TEST_WIN, work);
		await createGit(work).raw(["push", "-u", "origin", "main"]);
		return { work, remote, canonicalRoot: await fsp.realpath(work) };
	}

	// L2 に stale を仕込み、読み出し用の closure を返す。set が効いたことを先に観測するのは、
	// handle が undefined だと set / get が共に no-op になり toBeUndefined が vacuous に通るため。
	function seedStale(canonicalRoot: string, target: string): () => unknown {
		const cache = getContentCacheHandle(canonicalRoot);
		cache?.set(target, "stale", cache.generation);
		expect(cache?.get(target)).toBe("stale");
		return () => cache?.get(target);
	}

	it("evicts the L2 entry for a file changed by a fast-forward pull (merge)", async () => {
		const { work, remote, canonicalRoot } = await setupPullable();
		await pushFromOtherClone(remote, async (dir) => {
			await commitFile(dir, "first.md", "upstream\n", "upstream change");
		});
		acquireFileListCache(canonicalRoot);
		try {
			const read = seedStale(canonicalRoot, join(canonicalRoot, "first.md"));
			await pullImpl(TEST_WIN, work, "merge");
			expect(read()).toBeUndefined();
		} finally {
			releaseFileListCache(canonicalRoot);
		}
	});

	// local commit が無いと `--rebase` も単純 fast-forward になり、merge 版と同じ分岐しか通らない。
	// 非 conflict な local commit を 1 つ積んで rewind + replay を実際に通す。
	it("evicts the L2 entry for a file changed by pull --rebase", async () => {
		const { work, remote, canonicalRoot } = await setupPullable();
		await pushFromOtherClone(remote, async (dir) => {
			await commitFile(dir, "first.md", "upstream\n", "upstream change");
		});
		await commitFile(work, "local.md", "local\n", "local commit");
		acquireFileListCache(canonicalRoot);
		try {
			const read = seedStale(canonicalRoot, join(canonicalRoot, "first.md"));
			await pullImpl(TEST_WIN, work, "rebase");
			// replay が起きたことを観測する (fast-forward なら upstream commit が最上位に来る)。
			const log = (await createGit(work).raw(["log", "-2", "--format=%s"])).trim().split("\n");
			expect(log).toEqual(["local commit", "upstream change"]);
			expect(read()).toBeUndefined();
		} finally {
			releaseFileListCache(canonicalRoot);
		}
	});

	// `core.quotepath=false` は非 ASCII の 8 進 escape だけを止める。`"` を含む path は
	// なお `"q\"uote.md"` の形で quote されるため、`-z` が無いと cache key と一致しない。
	// win32 は `"` を file 名に使えないので POSIX 限定。
	it.skipIf(process.platform === "win32")(
		"evicts a path that git would quote in its non -z output",
		async () => {
			const quoted = 'q"uote.md';
			const { work, remote, canonicalRoot } = await setupPullable();
			await commitFile(work, quoted, "base\n", "add quoted");
			await createGit(work).raw(["push"]);
			await pushFromOtherClone(remote, async (dir) => {
				await commitFile(dir, quoted, "upstream\n", "upstream quoted");
			});
			acquireFileListCache(canonicalRoot);
			try {
				const read = seedStale(canonicalRoot, join(canonicalRoot, quoted));
				await pullImpl(TEST_WIN, work, "merge");
				expect(read()).toBeUndefined();
			} finally {
				releaseFileListCache(canonicalRoot);
			}
		},
	);

	it("evicts every file of a multi-file pull", async () => {
		const { work, remote, canonicalRoot } = await setupPullable();
		await commitFile(work, "second.md", "base\n", "add second");
		await createGit(work).raw(["push"]);
		await pushFromOtherClone(remote, async (dir) => {
			await fsp.writeFile(join(dir, "first.md"), "upstream first\n", "utf8");
			await fsp.writeFile(join(dir, "second.md"), "upstream second\n", "utf8");
			const dgit = createGit(dir);
			await dgit.raw(["add", "--", "first.md", "second.md"]);
			await dgit.raw(["commit", "-m", "upstream both"]);
		});
		acquireFileListCache(canonicalRoot);
		try {
			const readFirst = seedStale(canonicalRoot, join(canonicalRoot, "first.md"));
			const readSecond = seedStale(canonicalRoot, join(canonicalRoot, "second.md"));
			await pullImpl(TEST_WIN, work, "merge");
			expect(readFirst()).toBeUndefined();
			expect(readSecond()).toBeUndefined();
		} finally {
			releaseFileListCache(canonicalRoot);
		}
	});

	it("adds an upstream-created .md to L1", async () => {
		const { work, remote, canonicalRoot } = await setupPullable();
		await pushFromOtherClone(remote, async (dir) => {
			await commitFile(dir, "added.md", "added\n", "upstream add");
		});
		acquireFileListCache(canonicalRoot);
		try {
			await populateFileListCache(canonicalRoot, async () => [join(canonicalRoot, "first.md")]);
			await pullImpl(TEST_WIN, work, "merge");
			expect(getCachedMdFiles(canonicalRoot)).toContain(join(canonicalRoot, "added.md"));
		} finally {
			releaseFileListCache(canonicalRoot);
		}
	});

	it("removes an upstream-deleted .md from L1", async () => {
		const { work, remote, canonicalRoot } = await setupPullable();
		await pushFromOtherClone(remote, async (dir) => {
			await createGit(dir).raw(["rm", "--", "first.md"]);
			await createGit(dir).raw(["commit", "-m", "upstream delete"]);
		});
		acquireFileListCache(canonicalRoot);
		try {
			await populateFileListCache(canonicalRoot, async () => [join(canonicalRoot, "first.md")]);
			await pullImpl(TEST_WIN, work, "merge");
			expect(getCachedMdFiles(canonicalRoot)).not.toContain(join(canonicalRoot, "first.md"));
		} finally {
			releaseFileListCache(canonicalRoot);
		}
	});

	it("reflects an upstream rename as delete + create in L1", async () => {
		const { work, remote, canonicalRoot } = await setupPullable();
		await pushFromOtherClone(remote, async (dir) => {
			const dgit = createGit(dir);
			await dgit.raw(["mv", "first.md", "renamed.md"]);
			await dgit.raw(["commit", "-m", "upstream rename"]);
		});
		acquireFileListCache(canonicalRoot);
		try {
			await populateFileListCache(canonicalRoot, async () => [join(canonicalRoot, "first.md")]);
			await pullImpl(TEST_WIN, work, "merge");
			const files = getCachedMdFiles(canonicalRoot);
			expect(files).not.toContain(join(canonicalRoot, "first.md"));
			expect(files).toContain(join(canonicalRoot, "renamed.md"));
		} finally {
			releaseFileListCache(canonicalRoot);
		}
	});

	// merge conflict では HEAD が動かないため、HEAD 前後の diff だけでは空になる。
	// working tree には auto-merge 結果と marker が書かれているので index 差分で拾う。
	it("evicts the conflicted file even though the merge pull rejects", async () => {
		const { work, remote, canonicalRoot } = await setupPullable();
		await pushFromOtherClone(remote, async (dir) => {
			await commitFile(dir, "first.md", "upstream\n", "upstream change");
		});
		await commitFile(work, "first.md", "local\n", "local change");
		acquireFileListCache(canonicalRoot);
		try {
			const read = seedStale(canonicalRoot, join(canonicalRoot, "first.md"));
			await expect(pullImpl(TEST_WIN, work, "merge")).rejects.toThrow();
			expect(read()).toBeUndefined();
		} finally {
			releaseFileListCache(canonicalRoot);
		}
	});

	it("leaves the cache untouched for an up-to-date pull", async () => {
		const { work, canonicalRoot } = await setupPullable();
		acquireFileListCache(canonicalRoot);
		try {
			const read = seedStale(canonicalRoot, join(canonicalRoot, "first.md"));
			await pullImpl(TEST_WIN, work, "merge");
			expect(read()).toBe("stale");
		} finally {
			releaseFileListCache(canonicalRoot);
		}
	});

	it("adds tracked .md files to L1 on the first pull into an unborn branch", async () => {
		const { work: seed, remote } = await setupRepoWithRemote();
		dirsToCleanup.push(seed, remote);
		await createGit(seed).raw(["push", "-u", "origin", "main"]);
		const work = await initRepo();
		dirsToCleanup.push(work);
		await registerWorkspaceRoot(TEST_WIN, work);
		const wgit = createGit(work);
		await wgit.raw(["remote", "add", "origin", remote]);
		// unborn branch では `--set-upstream-to` が使えない (branch ref が無い) ので config を直に書く。
		await wgit.raw(["config", "branch.main.remote", "origin"]);
		await wgit.raw(["config", "branch.main.merge", "refs/heads/main"]);
		const canonicalRoot = await fsp.realpath(work);
		acquireFileListCache(canonicalRoot);
		try {
			await populateFileListCache(canonicalRoot, async () => []);
			await pullImpl(TEST_WIN, work, "merge");
			expect(getCachedMdFiles(canonicalRoot)).toContain(join(canonicalRoot, "first.md"));
		} finally {
			releaseFileListCache(canonicalRoot);
		}
	});

	// workspace が repo の subdir のケース (`git:check-repo` は `--is-inside-work-tree` 判定なので
	// 到達しうる)。`--relative` が無いと diff の path が repo root 相対になり、workspace 基準で
	// resolve した cache key と一致しない。
	it("evicts using workspace-relative paths when the workspace is a repo subdirectory", async () => {
		const { work, remote } = await setupRepoWithRemote();
		dirsToCleanup.push(work, remote);
		await fsp.mkdir(join(work, "sub"));
		await commitFile(work, join("sub", "x.md"), "base\n", "add sub/x.md");
		await createGit(work).raw(["push", "-u", "origin", "main"]);
		const workspace = join(work, "sub");
		await registerWorkspaceRoot(TEST_WIN, workspace);
		await pushFromOtherClone(remote, async (dir) => {
			await commitFile(dir, join("sub", "x.md"), "upstream\n", "upstream sub change");
		});
		const canonicalRoot = await fsp.realpath(workspace);
		acquireFileListCache(canonicalRoot);
		try {
			const read = seedStale(canonicalRoot, join(canonicalRoot, "x.md"));
			await pullImpl(TEST_WIN, workspace, "merge");
			expect(read()).toBeUndefined();
		} finally {
			releaseFileListCache(canonicalRoot);
		}
	});

	// rebase 中の残り commit を replay して working tree が変わる経路。conflict を解決した
	// file (a.md) ではなく、replay でしか変わらない file (b.md) を観測する。
	it("evicts a file rewritten by rebase --continue replaying the remaining commit", async () => {
		const { work, remote, canonicalRoot } = await setupPullable();
		await commitFile(work, "a.md", "base a\n", "add a");
		await commitFile(work, "b.md", "base b\n", "add b");
		await createGit(work).raw(["push"]);
		await pushFromOtherClone(remote, async (dir) => {
			await commitFile(dir, "a.md", "upstream a\n", "upstream a");
		});
		await commitFile(work, "a.md", "local a\n", "local a");
		await commitFile(work, "b.md", "local b\n", "local b");
		await expect(pullImpl(TEST_WIN, work, "rebase")).rejects.toThrow();
		await resolveConflictImpl(TEST_WIN, work, "a.md", "resolved a\n", "modify");
		acquireFileListCache(canonicalRoot);
		try {
			const read = seedStale(canonicalRoot, join(canonicalRoot, "b.md"));
			await finishConflictResolutionImpl(TEST_WIN, work);
			expect(read()).toBeUndefined();
		} finally {
			releaseFileListCache(canonicalRoot);
		}
	});

	it("evicts the marker version when rebase --continue stops at the next conflict", async () => {
		const { work, remote, canonicalRoot } = await setupPullable();
		await commitFile(work, "a.md", "base a\n", "add a");
		await commitFile(work, "c.md", "base c\n", "add c");
		await createGit(work).raw(["push"]);
		await pushFromOtherClone(remote, async (dir) => {
			await commitFile(dir, "a.md", "upstream a\n", "upstream a");
			await commitFile(dir, "c.md", "upstream c\n", "upstream c");
		});
		await commitFile(work, "a.md", "local a\n", "local a");
		await commitFile(work, "c.md", "local c\n", "local c");
		await expect(pullImpl(TEST_WIN, work, "rebase")).rejects.toThrow();
		await resolveConflictImpl(TEST_WIN, work, "a.md", "resolved a\n", "modify");
		acquireFileListCache(canonicalRoot);
		try {
			const read = seedStale(canonicalRoot, join(canonicalRoot, "c.md"));
			await expect(finishConflictResolutionImpl(TEST_WIN, work)).rejects.toThrow();
			expect(read()).toBeUndefined();
		} finally {
			releaseFileListCache(canonicalRoot);
		}
	});
});
