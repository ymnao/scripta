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

// `:` は POSIX shell の no-op builtin（exit 0 で即終了）。git は editor を
// `/bin/sh -c "<editor> <file>"` で起動するため、`:` を渡すとファイル未編集
// で 0 終了 → git は既存メッセージで commit を続行する。git for Windows も
// bash を内蔵するので同様に動作する。
//
// 重要: process.env から `GIT_EDITOR` / `EDITOR` / `VISUAL` を継承すると、
// `git rebase --continue` 等で editor が起動してハング or 失敗する。明示
// 上書きしないと、ユーザーが普段使っている vim / nano / VS Code 等が呼ば
// れて完了しない（`commit --no-edit` 経路は editor を呼ばないので影響なし）。
const NOOP_EDITOR = ":";

const GIT_ENV_OVERRIDES: NodeJS.ProcessEnv = {
	LC_ALL: "C",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "",
	SSH_ASKPASS: "",
	GIT_LITERAL_PATHSPECS: "1",
	GIT_EDITOR: NOOP_EDITOR,
	GIT_SEQUENCE_EDITOR: NOOP_EDITOR,
	EDITOR: NOOP_EDITOR,
	VISUAL: NOOP_EDITOR,
	GIT_PAGER: "cat",
	PAGER: "cat",
};

// simple-git 3.x の vulnerability ガード方針:
// process.env を子プロセスに forward する都合上、ユーザー環境にある GIT_EDITOR /
// GIT_ASKPASS / 等が触れた時点で reject される。本コードはこれらの値を意図的に
// 制御している（GIT_TERMINAL_PROMPT=0 / GIT_ASKPASS="" / SSH_ASKPASS="" で対話
// 入力を deny、`core.hooksPath=NULL` で hooks を無効化）ので、対応する unsafe
// フラグを明示的に opt-in する。攻撃者制御された値は他経路で防いでいるため、
// 旧 Rust 実装と同じセマンティクスを再現する目的で許可する。
const UNSAFE_FLAGS = {
	allowUnsafeHooksPath: true,
	allowUnsafeEditor: true,
	allowUnsafeAskPass: true,
	allowUnsafePager: true,
	allowUnsafeCredentialHelper: true,
	allowUnsafeConfigPaths: true,
	allowUnsafeSshCommand: true,
	allowUnsafeProtocolOverride: true,
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
		unsafe: UNSAFE_FLAGS,
	}).env({ ...process.env, ...GIT_ENV_OVERRIDES });
}

// `git --version` の存在確認用に baseDir 不要の instance を返す。
export function createGitNoCwd(): SimpleGit {
	return simpleGit({ binary: "git", unsafe: UNSAFE_FLAGS }).env({
		...process.env,
		...GIT_ENV_OVERRIDES,
	});
}

// simple-git GitError は `message` に git の stderr を含む。
// renderer 側 errors.ts の正規表現がマッチするよう、trim してそのまま流す。
export function extractGitErrorMessage(e: unknown): string {
	if (e instanceof Error) return e.message.trim();
	return String(e);
}
