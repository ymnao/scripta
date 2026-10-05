// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildGitEnv } from "./git-env";

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
