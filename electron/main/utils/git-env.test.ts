// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildGitEnv, findDisallowedRepoConfigKeys } from "./git-env";

describe("buildGitEnv", () => {
	it("drops an ambient GIT_DIR", () => {
		expect(buildGitEnv({ GIT_DIR: "/elsewhere/.git" })).not.toHaveProperty("GIT_DIR");
	});

	it("drops an ambient guarded key regardless of case", () => {
		expect(buildGitEnv({ git_dir: "/elsewhere/.git" })).not.toHaveProperty("git_dir");
	});

	it("drops an ambient PREFIX (guarded without the git_ prefix)", () => {
		expect(buildGitEnv({ PREFIX: "/opt/homebrew" })).not.toHaveProperty("PREFIX");
	});

	it("drops env-injected config (GIT_CONFIG_COUNT / KEY_n / VALUE_n)", () => {
		const env = buildGitEnv({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.pager",
			GIT_CONFIG_VALUE_0: "less",
		});
		expect(env).not.toHaveProperty("GIT_CONFIG_COUNT");
		expect(env).not.toHaveProperty("GIT_CONFIG_KEY_0");
		expect(env).not.toHaveProperty("GIT_CONFIG_VALUE_0");
	});

	it("keeps honored ambient git keys", () => {
		const ambient = {
			GIT_SSH_COMMAND: "ssh -i ~/.ssh/work",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Someone",
		};
		expect(buildGitEnv(ambient)).toMatchObject(ambient);
	});

	it("keeps non-guarded keys such as PATH / HOME / SSH_AUTH_SOCK", () => {
		const ambient = { PATH: "/usr/bin", HOME: "/home/u", SSH_AUTH_SOCK: "/tmp/agent.sock" };
		expect(buildGitEnv(ambient)).toMatchObject(ambient);
	});

	it("overrides an ambient GIT_EDITOR with the no-op editor", () => {
		expect(buildGitEnv({ GIT_EDITOR: "sleep 60" }).GIT_EDITOR).toBe(":");
	});
});

// `git config --list --show-scope --name-only -z` の出力を組み立てる。
function scoped(...pairs: [string, string][]): string {
	return pairs.map(([scope, name]) => `${scope}\0${name}\0`).join("");
}

describe("findDisallowedRepoConfigKeys", () => {
	it("accepts the keys git init writes", () => {
		const out = scoped(
			["local", "core.repositoryformatversion"],
			["local", "core.filemode"],
			["local", "core.bare"],
			["local", "core.logallrefupdates"],
			["local", "core.ignorecase"],
			["local", "core.precomposeunicode"],
		);
		expect(findDisallowedRepoConfigKeys(out)).toEqual([]);
	});

	it("accepts remote / branch keys under any subsection, keeping its case", () => {
		const out = scoped(
			["local", "remote.origin.url"],
			["local", "remote.origin.fetch"],
			["local", "branch.Feat/X.y.merge"],
		);
		expect(findDisallowedRepoConfigKeys(out)).toEqual([]);
	});

	it("rejects include directives, whose target a later pull can rewrite", () => {
		const out = scoped(["local", "include.path"], ["local", "includeif.gitdir:~/a.b/.path"]);
		expect(findDisallowedRepoConfigKeys(out)).toEqual([
			"include.path",
			"includeif.gitdir:~/a.b/.path",
		]);
	});

	it("accepts core.hookspath, which createGit overrides", () => {
		expect(findDisallowedRepoConfigKeys(scoped(["local", "core.hookspath"]))).toEqual([]);
	});

	it("rejects commit.gpgsign, which makes commit run a signing program", () => {
		expect(findDisallowedRepoConfigKeys(scoped(["local", "commit.gpgsign"]))).toEqual([
			"commit.gpgsign",
		]);
	});

	it("rejects a local core.fsmonitor", () => {
		expect(findDisallowedRepoConfigKeys(scoped(["local", "core.fsmonitor"]))).toEqual([
			"core.fsmonitor",
		]);
	});

	it("rejects a key from the worktree scope", () => {
		expect(findDisallowedRepoConfigKeys(scoped(["worktree", "core.fsmonitor"]))).toEqual([
			"core.fsmonitor",
		]);
	});

	it("rejects a non-allowed key under an allowed section with a subsection", () => {
		expect(findDisallowedRepoConfigKeys(scoped(["local", "remote.origin.uploadpack"]))).toEqual([
			"remote.origin.uploadpack",
		]);
	});

	it("rejects a subsection form of a key that is only allowed without one", () => {
		expect(findDisallowedRepoConfigKeys(scoped(["local", "user.x.name"]))).toEqual(["user.x.name"]);
	});

	it("rejects a key without a section", () => {
		expect(findDisallowedRepoConfigKeys(scoped(["local", "nosection"]))).toEqual(["nosection"]);
	});

	it("ignores keys from the global, system and command scopes", () => {
		const out = scoped(
			["global", "filter.lfs.clean"],
			["system", "credential.helper"],
			["command", "core.hookspath"],
		);
		expect(findDisallowedRepoConfigKeys(out)).toEqual([]);
	});

	it("lists a repeated key once", () => {
		const out = scoped(["local", "credential.helper"], ["local", "credential.helper"]);
		expect(findDisallowedRepoConfigKeys(out)).toEqual(["credential.helper"]);
	});
});
