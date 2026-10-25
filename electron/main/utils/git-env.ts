import { realpath } from "node:fs/promises";
import { platform } from "node:os";
import { type SimpleGit, simpleGit } from "simple-git";
import { relComponentsUnderRoot } from "./root-relative-path";
import { gitError, StructuredError } from "./structured-error";

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
// (B) の方針で尊重するユーザー環境のうち、git が操作する repo を変えず、通すのに
// UNSAFE_FLAGS への新しい許可が要らない key だけを列挙する。
//
// `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` / `GIT_CONFIG_PARAMETERS`
// を通さないのは、任意の config を env から注入する経路で、通すには新しい unsafe flag
// `allowUnsafeConfigEnvCount` と添字ごとの key 列挙が要るため（`.gitconfig` で代替できる）。
// `GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` 等を通さないのは、assertPathAllowed で
// 認可した workspace と git が実際に触る repo を env でずらせてしまうため。
// `GIT_SSL_*` 等の transport 系も通さない（`http.sslCAInfo` 等を `.gitconfig` に書けば効く）。
// `GIT_EXEC_PATH` は 3.x では子 git に届いていたが、4.x では `allowUnsafeExec` を要する
// 任意実行の経路なので通さない。
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
//     - allowUnsafeFsMonitor: `core.fsmonitor=false` で fsmonitor hook 無効化（config[] で固定、#705）
//     - allowUnsafeEditor:    `GIT_EDITOR=":"` 等で no-op editor（env で固定）
//     - allowUnsafeAskPass:   `GIT_ASKPASS=""` / `SSH_ASKPASS=""` で対話入力 deny
//     - allowUnsafePager:     `GIT_PAGER="cat"` / `PAGER="cat"` で pager 抑止
//
// (B) 我々は明示制御せず、ユーザーの普段の git 環境（`.gitconfig` / 環境変数）を
//     **意図的に尊重** するもの。UX 上ユーザーが手元の git でできることは
//     Electron 内でも同等にできるのが要件。攻撃者制御値の流入は
//     IPC 認可（assertPathAllowed）で workspace 単位に閉じ込めて防ぐ。
//     workspace 自身の `.git/config` も攻撃者制御になりうる（zip で渡されたフォルダ等）ので、
//     repo-local の設定は createGuardedGit の許可リストで別に検査する（#705）。
//     - allowUnsafeCredentialHelper: ユーザーの credential.helper（macOS keychain 等）
//     - allowUnsafeConfigPaths:      ユーザーの GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM / GIT_CONFIG を継承
//     - allowUnsafeSshCommand:       ユーザーの GIT_SSH_COMMAND / GIT_SSH（カスタム鍵指定など）を継承
//
// `allowUnsafeProtocolOverride` は (A) (B) どちらにも該当しない（我々は -c 経由で
// protocol.allow を設定せず、process.env 経路でも継承する必要がない）ため除外する。
const UNSAFE_FLAGS = {
	allowUnsafeHooksPath: true,
	allowUnsafeFsMonitor: true,
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
// `core.fsmonitor=false` で repo-local の fsmonitor hook（`status` / `diff` / `add` で起動する）を無効化、
// `core.quotepath=false` で 非 ASCII path を 8 進エスケープしない。
export function createGit(canonicalRepoPath: string): SimpleGit {
	return simpleGit({
		...BASE_OPTIONS,
		baseDir: canonicalRepoPath,
		maxConcurrentProcesses: 1,
		config: [`core.hooksPath=${NULL_HOOKS}`, "core.fsmonitor=false", "core.quotepath=false"],
	}).env(buildGitEnv(process.env));
}

// repo-local（`.git/config` / `config.worktree` と、そこから include されたファイル）に置いてよい
// key。`git init` / `clone` / `remote add` / `branch -u` が書くものと、コマンドを起動しない
// 少数の設定に限る。
// `core.hookspath` は husky 等が書くので許可する。値は createGit の `-c` が上書きする
// （`-c` の command scope は local より優先する）。`core.fsmonitor` も同じく上書きされるが、
// 開くだけで起動する経路なので二重に拒否しておく。`include.path` / `includeif.*.path` を
// 許可しないのは、include 先を working tree の tracked file にされると、検査を通った後の pull が
// その中身を書き換え、同じ操作の後続コマンドが検査していない設定で動きうるため。
// `pull.rebase` / `branch.*.rebase` は値に関わらず pullImpl が `--rebase` / `--no-rebase` を
// 明示するので効かない。`commit.gpgsign` は commit のたびに署名プログラムを起動させるので許可しない。
//
// 危険な key を列挙して `-c` で上書きする形（denylist）にしないのは 2 つの理由から:
// コマンドを起動する key は `filter.*` / `credential.helper` / `core.sshCommand` /
// `remote.*.uploadpack` / `protocol.*.allow` + `ext::` / `merge.*.driver` / `gpg.program` /
// `core.alternateRefsCommand` / `submodule.*.update` と広く、git の版で増える。また `-c` は
// global の設定（user の credential helper や LFS などの filter）まで同時に潰す。
const ALLOWED_REPO_KEYS: ReadonlySet<string> = new Set([
	"core.repositoryformatversion",
	"core.filemode",
	"core.bare",
	"core.logallrefupdates",
	"core.ignorecase",
	"core.precomposeunicode",
	"core.symlinks",
	"core.hookspath",
	"core.autocrlf",
	"core.eol",
	"core.untrackedcache",
	"core.sparsecheckout",
	"core.sparsecheckoutcone",
	"index.version",
	"extensions.worktreeconfig",
	"extensions.objectformat",
	"extensions.refstorage",
	"user.name",
	"user.email",
	"pull.rebase",
	"lfs.repositoryformatversion",
]);

// `<section>.<subsection>.<key>` 形式の許可。subsection（remote 名 / branch 名）は問わない。
const ALLOWED_REPO_SUBSECTION_KEYS: ReadonlySet<string> = new Set([
	"remote.url",
	"remote.pushurl",
	"remote.fetch",
	"remote.tagopt",
	"remote.prune",
	"remote.gh-resolved",
	"branch.remote",
	"branch.merge",
	"branch.rebase",
]);

// git は section と末尾の key を小文字に正規化して出力し、subsection は大文字小文字を保つ。
function isAllowedRepoConfigKey(name: string): boolean {
	const first = name.indexOf(".");
	const last = name.lastIndexOf(".");
	if (first < 0) return false;
	if (first === last) return ALLOWED_REPO_KEYS.has(name);
	return ALLOWED_REPO_SUBSECTION_KEYS.has(name.slice(0, first) + name.slice(last));
}

// `git config --list --show-scope --name-only -z` の出力（`scope\0name\0` の繰り返し）から、
// repo-local の scope にある許可外の key を重複なく返す。include されたファイルの key は
// include 元の scope で出る。
export function findDisallowedRepoConfigKeys(out: string): string[] {
	const tokens = out.split("\0");
	const found = new Set<string>();
	for (let i = 0; i + 1 < tokens.length; i += 2) {
		const scope = tokens[i];
		const name = tokens[i + 1];
		if (scope !== "local" && scope !== "worktree") continue;
		if (!isAllowedRepoConfigKey(name)) found.add(name);
	}
	return [...found];
}

// workspace の中にあるのに `.git` という component を通らない git dir（`.git` を別 dir への symlink や
// `gitdir: store` の gitfile にした配置）を拒否する。path-guard の assertOutsideGitDir は path の
// `.git` component で fs IPC の書き込みを止めるので、この配置では git dir の config を renderer から
// 書けてしまい、検査と本処理の間に書き換える race が残る。worktree（`.git/worktrees/<x>`）と
// submodule（`.git/modules/<x>`）は `.git` を通るので影響しない。workspace の外の git dir
// （workspace が repo の subdir / `--separate-git-dir`）は fs IPC から書けないので対象外。
async function assertGitDirUnderDotGit(git: SimpleGit, canonicalRepoPath: string): Promise<void> {
	let out: string;
	try {
		out = await git.raw(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
	} catch (e) {
		throw gitError(extractGitErrorMessage(e));
	}
	for (const dir of out.split("\n").filter((l) => l.length > 0)) {
		// `--path-format=absolute` は symlink を解決した path を返す（git 2.56.0 で実測）が、
		// canonicalRepoPath と同じ realpath の表記に揃えてから比べる。
		const components = relComponentsUnderRoot(canonicalRepoPath, await realpath(dir));
		if (components !== null && !components.includes(".git")) {
			throw new StructuredError(
				"GIT_UNSAFE_CONFIG",
				`git directory inside the workspace is not under .git: ${components.join("/")}`,
			);
		}
	}
}

// createGit に加えて、repo-local の設定が許可リストに収まっていることと、git dir の配置を確かめてから
// 返す。この 2 つの検査に使う `rev-parse` と `git config --list` は、fsmonitor も filter も
// 起動しない（git 2.56.0 で実測）。
export async function createGuardedGit(canonicalRepoPath: string): Promise<SimpleGit> {
	const git = createGit(canonicalRepoPath);
	await assertGitDirUnderDotGit(git, canonicalRepoPath);
	let out: string;
	try {
		out = await git.raw(["config", "--list", "--show-scope", "--name-only", "-z"]);
	} catch (e) {
		throw gitError(extractGitErrorMessage(e));
	}
	const disallowed = findDisallowedRepoConfigKeys(out);
	if (disallowed.length > 0) {
		throw new StructuredError(
			"GIT_UNSAFE_CONFIG",
			`repository config has keys scripta does not allow: ${disallowed.join(", ")}`,
		);
	}
	return git;
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
