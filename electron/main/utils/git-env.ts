import { platform } from "node:os";
import { type SimpleGit, simpleGit } from "simple-git";

// simple-git ベースで git コマンド実行環境を集約。
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

// simple-git 3.x の vulnerability ガード opt-in。フラグは 2 系統に分かれる：
//
// (A) 我々が GIT_ENV_OVERRIDES / config[] で **明示的に安全な値に固定** している
//     ものを simple-git に通すための opt-in。固定値は本ファイル内で確認可能：
//     - allowUnsafeHooksPath: `core.hooksPath=NULL` で hooks 無効化（config[] で固定）
//     - allowUnsafeEditor:    `GIT_EDITOR=":"` 等で no-op editor（env で固定）
//     - allowUnsafeAskPass:   `GIT_ASKPASS=""` / `SSH_ASKPASS=""` で対話入力 deny
//     - allowUnsafePager:     `GIT_PAGER="cat"` / `PAGER="cat"` で pager 抑止
//
// (B) 我々は明示制御せず、ユーザーの普段の git 環境（`.gitconfig` / 環境変数）を
//     **意図的に尊重** するもの。UX 上ユーザーが手元の git でできることは
//     Electron 内でも同等にできるのが要件のため、process.env をそのまま継承する。
//     攻撃者制御値の流入は
//     IPC 認可（assertPathAllowed）で workspace 単位に閉じ込めて防ぐ。
//     - allowUnsafeCredentialHelper: ユーザーの credential.helper（macOS keychain 等）
//     - allowUnsafeConfigPaths:      ユーザーの GIT_CONFIG_* / XDG_CONFIG_HOME を継承
//     - allowUnsafeSshCommand:       ユーザーの GIT_SSH_COMMAND（カスタム鍵指定など）を継承
//
// `allowUnsafeProtocolOverride` は (A) (B) どちらにも該当しない（我々は -c 経由で
// protocol.allow を設定せず、process.env 経路でも継承する必要がない）ため除外する。
const UNSAFE_FLAGS = {
	allowUnsafeHooksPath: true,
	allowUnsafeEditor: true,
	allowUnsafeAskPass: true,
	allowUnsafePager: true,
	allowUnsafeCredentialHelper: true,
	allowUnsafeConfigPaths: true,
	allowUnsafeSshCommand: true,
};

// 与えられた canonical な repo path を baseDir にした SimpleGit instance を返す。
// `core.hooksPath=/dev/null` で hooks を無効化、
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
