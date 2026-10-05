import { platform } from "node:os";
import { type SimpleGit, simpleGit } from "simple-git";

// simple-git ベースで git コマンド実行環境を集約。
// 環境変数で対話入力経路を全 deny し、`LC_ALL=C` でエラー文を英語固定にする
// （git.ts の structured-error 分類 `classifyGitError` は英語 stderr 前提）。
//
// 重要: `.env()` には `buildGitEnv(process.env)` で **既存 env を温存** して渡すこと。
// simple-git の `.env(obj)` は spawn env を丸ごと差し替えるので、空の env を渡すと
// PATH / HOME が消えて git バイナリ自体が起動できなくなる / `.gitconfig` が読めなく
// なる（credential helper も含む）。

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

// ambient env のうち、simple-git 4 が guarded と見なす key（後述）でも子 git に通すもの。
// (B) の方針で尊重するユーザー環境のうち、env でしか指定できず、かつ UNSAFE_FLAGS で
// 許可済みの category に収まる key だけを列挙する。
//
// `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` / `GIT_CONFIG_PARAMETERS`
// を通さないのは、任意の config を env から注入する経路で、通すには新しい unsafe flag
// `allowUnsafeConfigEnvCount` と添字ごとの key 列挙が要るため（`.gitconfig` で代替できる）。
// `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` 等を通さないのは、assertPathAllowed で
// 認可した workspace と git が実際に触る repo を env でずらせてしまうため。
// `GIT_SSL_*` 等の transport 系も通さない（`http.sslCAInfo` 等を `.gitconfig` に書けば効く）。
const HONORED_AMBIENT_KEYS = [
	"GIT_SSH_COMMAND",
	"GIT_SSH",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_CONFIG",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
];

// 自前フィルタと simple-git の `allowEnvironment` を同じ定数から導出する。別々に持つと
// 「フィルタは通したが simple-git が throw する」ずれが起きる。
const ALLOW_ENVIRONMENT: readonly string[] = [
	...Object.keys(GIT_ENV_OVERRIDES),
	...HONORED_AMBIENT_KEYS,
];
const ALLOWED_LOWER = new Set(ALLOW_ENVIRONMENT.map((key) => key.toLowerCase()));

// simple-git 4 の allow-environment plugin と同じ guarded 判定（`git_` 接頭辞 + 非 `git_`
// の既知 key）。判定元の `@simple-git/argv-parser` は transitive dep なので import せず
// 複製している。simple-git を bump したら、同 package の `GitEnvKeys` に非 `git_` key が
// 増えていないか確認すること（増えた key が ambient にあると全 git 操作が throw する）。
const GUARDED_NON_GIT_KEYS = new Set(["editor", "visual", "pager", "ssh_askpass", "prefix"]);

function isGuardedEnvKey(normalised: string): boolean {
	return normalised.startsWith("git_") || GUARDED_NON_GIT_KEYS.has(normalised);
}

// process.env を `.env()` に丸ごと渡すと、simple-git 4 は許可外の guarded key ごとに throw
// する（ambient なら黙って strip するが、`.env()` 経由は明示扱い）。同じ判定で先に落とす。
export function buildGitEnv(ambient: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(ambient)) {
		const normalised = key.toLowerCase().trim();
		if (isGuardedEnvKey(normalised) && !ALLOWED_LOWER.has(normalised)) continue;
		env[key] = value;
	}
	return { ...env, ...GIT_ENV_OVERRIDES };
}

// simple-git の vulnerability ガード opt-in。フラグは 2 系統に分かれる：
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
//     Electron 内でも同等にできるのが要件。攻撃者制御値の流入は
//     IPC 認可（assertPathAllowed）で workspace 単位に閉じ込めて防ぐ。
//     - allowUnsafeCredentialHelper: ユーザーの credential.helper（macOS keychain 等）
//     - allowUnsafeConfigPaths:      ユーザーの GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM / GIT_CONFIG /
//                                    XDG_CONFIG_HOME を継承
//     - allowUnsafeSshCommand:       ユーザーの GIT_SSH_COMMAND / GIT_SSH（カスタム鍵指定など）を継承
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

const BASE_OPTIONS = {
	binary: "git",
	unsafe: UNSAFE_FLAGS,
	allowEnvironment: ALLOW_ENVIRONMENT,
};

// 与えられた canonical な repo path を baseDir にした SimpleGit instance を返す。
// `core.hooksPath=/dev/null` で hooks を無効化、
// `core.quotepath=false` で 非 ASCII path を 8 進エスケープしない。
export function createGit(canonicalRepoPath: string): SimpleGit {
	return simpleGit({
		...BASE_OPTIONS,
		baseDir: canonicalRepoPath,
		maxConcurrentProcesses: 1,
		config: [`core.hooksPath=${NULL_HOOKS}`, "core.quotepath=false"],
	}).env(buildGitEnv(process.env));
}

// `git --version` の存在確認用に baseDir 不要の instance を返す。
export function createGitNoCwd(): SimpleGit {
	return simpleGit(BASE_OPTIONS).env(buildGitEnv(process.env));
}

// simple-git GitError は `message` に git の stderr を含む。
// classifyGitError が種別を判定できるよう、trim した生 stderr を返す。
export function extractGitErrorMessage(e: unknown): string {
	if (e instanceof Error) return e.message.trim();
	return String(e);
}
