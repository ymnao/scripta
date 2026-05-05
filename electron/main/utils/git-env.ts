import { platform } from "node:os";
import { type SimpleGit, simpleGit } from "simple-git";

// 旧 Tauri 版 git_sync.rs の git_command(path, args) 相当を simple-git で集約。
// 環境変数で対話入力経路を全 deny し、`LC_ALL=C` でエラー文を英語固定にする
// （renderer 側 src/lib/errors.ts の正規表現は英語前提）。
//
// 重要: `.env({...process.env, ...})` で **既存 env を温存** すること。空の env を
// 渡すと PATH / HOME が消えて git バイナリ自体が起動できなくなる / `.gitconfig`
// が読めなくなる（credential helper も含む）。

const NULL_HOOKS = platform() === "win32" ? "NUL" : "/dev/null";

const GIT_ENV_OVERRIDES: NodeJS.ProcessEnv = {
	LC_ALL: "C",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	GIT_LITERAL_PATHSPECS: "1",
};

// 与えられた canonical な repo path を baseDir にした SimpleGit instance を返す。
// `core.hooksPath=/dev/null` で hooks を無効化（旧 Rust と同じ）、
// `core.quotepath=false` で 非 ASCII path を 8 進エスケープしない。
export function createGit(canonicalRepoPath: string): SimpleGit {
	return simpleGit({
		baseDir: canonicalRepoPath,
		binary: "git",
		maxConcurrentProcesses: 1,
		config: [`core.hooksPath=${NULL_HOOKS}`, "core.quotepath=false"],
	}).env({ ...process.env, ...GIT_ENV_OVERRIDES });
}

// `git --version` の存在確認用に baseDir 不要の instance を返す。
export function createGitNoCwd(): SimpleGit {
	return simpleGit({ binary: "git" }).env({ ...process.env, ...GIT_ENV_OVERRIDES });
}

// simple-git GitError は `message` に git の stderr を含む。
// renderer 側 errors.ts の正規表現がマッチするよう、trim してそのまま流す。
export function extractGitErrorMessage(e: unknown): string {
	if (e instanceof Error) return e.message.trim();
	return String(e);
}
