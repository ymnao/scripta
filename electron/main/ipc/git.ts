import { promises as fsp } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as pathResolve } from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import type { ConflictContent, GitStatus } from "../../../src/types/git-sync";
import { isErrnoCode } from "../utils/fs-errors";
import { createGit, createGitNoCwd, extractGitErrorMessage } from "../utils/git-env";
import {
	isStageNotFound,
	MAX_CONFLICT_CONTENT_SIZE,
	validateRefName,
	validateRelativePath,
} from "../utils/git-validators";
import { assertPathAllowed } from "../utils/path-guard";

// git sync 操作を simple-git ベースで集約する IPC ハンドラ群。
//
// 設計の要点:
// - すべての impl は冒頭で `assertPathAllowed(senderId, workspacePath)` を呼んで
//   canonical を取得し、I/O はその canonical で実施する（fs.ts / search.ts と同方針）。
// - simple-git の高水準 API（.commit / .pull / .push）は parsed result を返すが、
//   git の raw stdout / stderr をそのまま renderer に流したいため `git.raw([...])`
//   を主軸に使う（特に `git show :2:path` には raw 必須）。
// - エラーメッセージは git stderr をそのまま renderer に流す（LC_ALL=C で英語固定 →
//   src/lib/errors.ts の `/conflict/i` `/nothing to commit/i` 等のパターンが機能する）。

// `git status --porcelain` の prefix で conflict（unmerged stage）を判定する。
const CONFLICT_PREFIXES = new Set(["UU ", "AA ", "DD ", "AU ", "UA ", "DU ", "UD "]);

async function checkAvailableImpl(): Promise<boolean> {
	try {
		await createGitNoCwd().version();
		return true;
	} catch {
		return false;
	}
}

async function checkRepoImpl(senderId: number, path: string): Promise<boolean> {
	let canonical: string;
	try {
		canonical = assertPathAllowed(senderId, path);
	} catch {
		return false;
	}
	try {
		const out = await createGit(canonical).raw(["rev-parse", "--is-inside-work-tree"]);
		return out.trim() === "true";
	} catch {
		return false;
	}
}

async function statusImpl(senderId: number, path: string): Promise<GitStatus> {
	const canonical = assertPathAllowed(senderId, path);
	const git = createGit(canonical);
	// 3 つの git 呼び出しは独立しているので並列化する。useGitSync の refresh
	// で頻繁に呼ばれるホットパスのため、逐次（3 spawn 順次）→ 並列で 1/3 程度に短縮。
	// branch / remote はエラーを許容（unborn HEAD / remote 未設定）するので
	// catch で fallback。porcelain は失敗時に throw して呼び出し元へ伝える。
	const [branch, porcelain, hasRemote] = await Promise.all([
		git
			.raw(["rev-parse", "--abbrev-ref", "HEAD"])
			.then((b) => b.trim())
			.catch(() => ""),
		git.raw(["status", "--porcelain"]),
		git
			.raw(["remote"])
			.then((r) => r.trim().length > 0)
			.catch(() => false),
	]);
	const lines = porcelain.split("\n").filter((l) => l.length > 0);
	const conflictFiles = lines
		.filter((l) => l.length >= 3 && CONFLICT_PREFIXES.has(l.slice(0, 3)))
		.map((l) => l.slice(3));
	return { branch, changedFilesCount: lines.length, conflictFiles, hasRemote };
}

async function addAllImpl(senderId: number, path: string): Promise<void> {
	const canonical = assertPathAllowed(senderId, path);
	try {
		await createGit(canonical).raw(["add", "-A"]);
	} catch (e) {
		throw new Error(extractGitErrorMessage(e));
	}
}

async function commitImpl(senderId: number, path: string, message: string): Promise<string> {
	const canonical = assertPathAllowed(senderId, path);
	let out: string;
	try {
		out = (await createGit(canonical).raw(["commit", "-m", message])).trim();
	} catch (e) {
		throw new Error(extractGitErrorMessage(e));
	}
	// simple-git は stderr が空だと success 扱いする（git commit が
	// "nothing to commit" を stdout に出すケース）。renderer 側 useGitSync.ts は
	// msg.includes("nothing to commit") でハンドリングしているので、明示的に
	// throw してエラー経路に載せる。
	if (/nothing (?:to commit|added to commit)/i.test(out)) {
		throw new Error(out);
	}
	return out;
}

async function pullImpl(senderId: number, path: string, syncMethod: string): Promise<string> {
	const canonical = assertPathAllowed(senderId, path);
	if (syncMethod !== "merge" && syncMethod !== "rebase") {
		throw new Error(`Invalid sync_method: ${syncMethod}. Expected "merge" or "rebase".`);
	}
	const args = syncMethod === "rebase" ? ["pull", "--rebase"] : ["pull"];
	try {
		return (await createGit(canonical).raw(args)).trim();
	} catch (e) {
		const msg = extractGitErrorMessage(e);
		// 初回 pull で upstream 未設定 → 成功扱い（空文字列を返す）。
		if (msg.includes("no tracking information")) return "";
		throw new Error(msg);
	}
}

async function pushImpl(senderId: number, path: string): Promise<string> {
	const canonical = assertPathAllowed(senderId, path);
	const git = createGit(canonical);
	let firstError: unknown;
	try {
		return (await git.raw(["push"])).trim();
	} catch (e) {
		firstError = e;
	}
	const msg = extractGitErrorMessage(firstError);
	// 初回 push で upstream 未設定 → 自動で `-u origin <branch>` を付けて再試行。
	if (!(msg.includes("no upstream branch") || msg.includes("has no upstream"))) {
		throw new Error(msg);
	}
	// branch / remote の取得は独立なので並列化（再試行経路の追加レイテンシを抑える）。
	const [branch, remoteList] = await Promise.all([
		git.raw(["rev-parse", "--abbrev-ref", "HEAD"]).then((b) => b.trim()),
		git
			.raw(["remote"])
			.then((r) => r.trim())
			.catch(() => ""),
	]);
	if (!branch) throw new Error(msg);
	validateRefName(branch);
	const remote = remoteList ? remoteList.split("\n")[0] : "origin";
	validateRefName(remote);
	try {
		return (await git.raw(["push", "-u", remote, branch])).trim();
	} catch (e) {
		throw new Error(extractGitErrorMessage(e));
	}
}

async function getConflictedFilesImpl(senderId: number, path: string): Promise<string[]> {
	const canonical = assertPathAllowed(senderId, path);
	try {
		const out = await createGit(canonical).raw(["diff", "--name-only", "--diff-filter=U"]);
		return out.split("\n").filter((l) => l.length > 0);
	} catch (e) {
		throw new Error(extractGitErrorMessage(e));
	}
}

async function getConflictContentImpl(
	senderId: number,
	path: string,
	filePath: string,
): Promise<ConflictContent> {
	const canonical = assertPathAllowed(senderId, path);
	validateRelativePath(filePath);
	const git = createGit(canonical);
	const fetchStage = async (n: 2 | 3, label: "ours" | "theirs"): Promise<string> => {
		try {
			// `--` を付けない（git show は stage ref を pathspec
			// と誤解しないため）。simple-git の高水準 .show() は内部で `--` を付ける
			// 可能性があるため raw を使う。
			const c = await git.raw(["show", `:${n}:${filePath}`]);
			const bytes = Buffer.byteLength(c, "utf8");
			if (bytes > MAX_CONFLICT_CONTENT_SIZE) {
				throw new Error(
					`Conflict content for ${label} (${bytes} bytes) exceeds ${MAX_CONFLICT_CONTENT_SIZE} byte limit`,
				);
			}
			return c;
		} catch (e) {
			const msg = extractGitErrorMessage(e);
			// modify/delete conflict（DU/UD）で stage が無いケースは empty で fallback。
			if (isStageNotFound(msg)) return "";
			throw new Error(msg);
		}
	};
	// stage 2 / 3 は独立 git show なので並列で取得。conflict resolver を開く
	// 直前のブロッキング処理のため、UX 改善に直結する。
	const [ours, theirs] = await Promise.all([fetchStage(2, "ours"), fetchStage(3, "theirs")]);
	return { ours, theirs };
}

async function resolveConflictImpl(
	senderId: number,
	path: string,
	filePath: string,
	content: string,
	resolution: "modify" | "delete",
): Promise<void> {
	const canonical = assertPathAllowed(senderId, path);
	validateRelativePath(filePath);
	if (resolution !== "modify" && resolution !== "delete") {
		throw new Error(`Invalid resolution: ${resolution}. Expected "modify" or "delete".`);
	}
	const git = createGit(canonical);
	if (resolution === "delete") {
		try {
			await git.raw(["rm", "-f", "--", filePath]);
		} catch (e) {
			throw new Error(extractGitErrorMessage(e));
		}
		return;
	}
	// modify — repo 内への安全な書き込み。
	const target = pathResolve(canonical, filePath);
	// file_path 自身が symlink の場合は拒否（別ファイルへの surprise write を防ぐ）。
	// lstat は symlink 自身を検査するため、canonical 化前の target に対して実行する必要がある。
	try {
		const st = await fsp.lstat(target);
		if (st.isSymbolicLink()) {
			throw new Error("file_path is a symbolic link; refusing to write");
		}
	} catch (e) {
		if (!isErrnoCode(e, "ENOENT")) throw e;
	}
	// 親ディレクトリの canonical を取得して、その配下で I/O する。fs.ts と同じく
	// 「判定に使った canonical をそのまま実 I/O に使う」方針で TOCTOU を最小化。
	// assertPathAllowed が realpathBestEffort で symlink を解決し、bounds 違反なら throw。
	const canonicalParent = assertPathAllowed(senderId, dirname(target));
	const canonicalTarget = join(canonicalParent, basename(target));
	await fsp.mkdir(canonicalParent, { recursive: true });
	await fsp.writeFile(canonicalTarget, content, "utf8");
	try {
		// `git add` は repo-relative path を期待する（git が repo root から自動的に解釈）。
		await git.raw(["add", "--", filePath]);
	} catch (e) {
		throw new Error(extractGitErrorMessage(e));
	}
}

async function finishConflictResolutionImpl(senderId: number, path: string): Promise<string> {
	const canonical = assertPathAllowed(senderId, path);
	const git = createGit(canonical);
	const gitDirRaw = (await git.raw(["rev-parse", "--git-dir"])).trim();
	const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : pathResolve(canonical, gitDirRaw);
	const exists = (sub: string): Promise<boolean> =>
		fsp.access(join(gitDir, sub)).then(
			() => true,
			() => false,
		);
	// 3 つの marker file の存在チェックは独立なので並列で。3 stat → 1 往復。
	// 判定は rebase 系を merge より優先。
	const [rebaseMerge, rebaseApply, mergeHead] = await Promise.all([
		exists("rebase-merge"),
		exists("rebase-apply"),
		exists("MERGE_HEAD"),
	]);
	if (rebaseMerge || rebaseApply) {
		try {
			return (await git.raw(["rebase", "--continue"])).trim();
		} catch (e) {
			throw new Error(extractGitErrorMessage(e));
		}
	}
	if (mergeHead) {
		try {
			return (await git.raw(["commit", "--no-edit"])).trim();
		} catch (e) {
			throw new Error(extractGitErrorMessage(e));
		}
	}
	throw new Error("Not in a merge or rebase state");
}

function emitConflictResolvedImpl(senderId: number, workspacePath: string): void {
	// 認可: 送信元の allowedRoots に当該 workspace が含まれることを確認してから
	// broadcast する。renderer は信頼できない前提なので、別 window から偽装
	// emit で他 workspace の `pausedRef` を解除されないように防ぐ。
	// 正規経路（conflict window）は createConflictWindow 内で
	// `setActiveWorkspaceForWindow(childId, canonical)` 済みのため pass する。
	assertPathAllowed(senderId, workspacePath);
	// 該当 workspace のみ受信側で `pausedRef` をクリアできるよう、
	// payload に workspace path を載せて broadcast する。受信側
	// (useGitSync.ts) で照合し、別 workspace の未解決 conflict が
	// このイベントで誤ってクリアされる回帰を防ぐ。
	for (const win of BrowserWindow.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send("git:conflict-resolved", workspacePath);
		}
	}
}

async function getLastCommitTimeImpl(senderId: number, path: string): Promise<string | null> {
	let canonical: string;
	try {
		canonical = assertPathAllowed(senderId, path);
	} catch {
		return null;
	}
	try {
		const out = (await createGit(canonical).raw(["log", "-1", "--format=%ci"])).trim();
		return out.length > 0 ? out : null;
	} catch {
		// 空 repo（HEAD が無い）等は null。
		return null;
	}
}

export function registerGitIpc(): void {
	ipcMain.handle("git:check-available", () => checkAvailableImpl());
	ipcMain.handle("git:check-repo", (event, path: string) => checkRepoImpl(event.sender.id, path));
	ipcMain.handle("git:status", (event, path: string) => statusImpl(event.sender.id, path));
	ipcMain.handle("git:add-all", (event, path: string) => addAllImpl(event.sender.id, path));
	ipcMain.handle("git:commit", (event, path: string, message: string) =>
		commitImpl(event.sender.id, path, message),
	);
	ipcMain.handle("git:pull", (event, path: string, syncMethod: string) =>
		pullImpl(event.sender.id, path, syncMethod),
	);
	ipcMain.handle("git:push", (event, path: string) => pushImpl(event.sender.id, path));
	ipcMain.handle("git:get-conflicted-files", (event, path: string) =>
		getConflictedFilesImpl(event.sender.id, path),
	);
	ipcMain.handle("git:get-conflict-content", (event, path: string, filePath: string) =>
		getConflictContentImpl(event.sender.id, path, filePath),
	);
	ipcMain.handle(
		"git:resolve-conflict",
		(event, path: string, filePath: string, content: string, resolution: "modify" | "delete") =>
			resolveConflictImpl(event.sender.id, path, filePath, content, resolution),
	);
	ipcMain.handle("git:finish-conflict-resolution", (event, path: string) =>
		finishConflictResolutionImpl(event.sender.id, path),
	);
	ipcMain.handle("git:get-last-commit-time", (event, path: string) =>
		getLastCommitTimeImpl(event.sender.id, path),
	);
	ipcMain.handle("git:emit-conflict-resolved", (event, workspacePath: string) => {
		emitConflictResolvedImpl(event.sender.id, workspacePath);
	});
}

export const __testing = {
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
};
