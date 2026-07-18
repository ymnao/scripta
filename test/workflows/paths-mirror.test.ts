import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

// ci.yml + ci-skip.yml と codeql.yml + codeql-skip.yml は
// paths-ignore (実 workflow) と paths (stub workflow) が完全補完である必要があり、
// 片側だけ変わると docs-only PR で required check の状態が壊れる
// (未生成 → BLOCKED、または stub 側が起動せず ci.yml が実 job で走る)。
// 4 workflow 間で path 定義の drift を防ぐ pattern-level 検証。

const WORKFLOWS_DIR = join(process.cwd(), ".github", "workflows");

type WorkflowEvents = {
	push?: { "paths-ignore"?: string[]; paths?: string[] };
	pull_request?: { "paths-ignore"?: string[]; paths?: string[] };
};

type Workflow = { on: WorkflowEvents };

function loadWorkflow(name: string): Workflow {
	const raw = readFileSync(join(WORKFLOWS_DIR, name), "utf8");
	return load(raw) as Workflow;
}

function sortedPaths(list: string[] | undefined): string[] {
	return [...(list ?? [])].sort();
}

const CI = loadWorkflow("ci.yml");
const CI_SKIP = loadWorkflow("ci-skip.yml");
const CODEQL = loadWorkflow("codeql.yml");
const CODEQL_SKIP = loadWorkflow("codeql-skip.yml");

describe("workflow paths-mirror", () => {
	describe("ci pair (ci.yml + ci-skip.yml)", () => {
		it("ci.yml: push.paths-ignore === pull_request.paths-ignore", () => {
			expect(sortedPaths(CI.on.push?.["paths-ignore"])).toEqual(
				sortedPaths(CI.on.pull_request?.["paths-ignore"]),
			);
		});

		it("ci-skip.yml: push.paths === pull_request.paths", () => {
			expect(sortedPaths(CI_SKIP.on.push?.paths)).toEqual(
				sortedPaths(CI_SKIP.on.pull_request?.paths),
			);
		});

		it("ci.yml paths-ignore === ci-skip.yml paths (補完 pair 整合)", () => {
			expect(sortedPaths(CI.on.pull_request?.["paths-ignore"])).toEqual(
				sortedPaths(CI_SKIP.on.pull_request?.paths),
			);
		});
	});

	describe("codeql pair (codeql.yml + codeql-skip.yml)", () => {
		it("codeql.yml: push.paths-ignore === pull_request.paths-ignore", () => {
			expect(sortedPaths(CODEQL.on.push?.["paths-ignore"])).toEqual(
				sortedPaths(CODEQL.on.pull_request?.["paths-ignore"]),
			);
		});

		it("codeql.yml paths-ignore === codeql-skip.yml paths (補完 pair 整合)", () => {
			expect(sortedPaths(CODEQL.on.pull_request?.["paths-ignore"])).toEqual(
				sortedPaths(CODEQL_SKIP.on.pull_request?.paths),
			);
		});
	});

	describe("全 pair 統一 pattern", () => {
		it("4 workflow の path 定義がすべて同一", () => {
			const canonical = sortedPaths(CI.on.pull_request?.["paths-ignore"]);
			expect(canonical).not.toHaveLength(0);
			expect(sortedPaths(CI_SKIP.on.pull_request?.paths)).toEqual(canonical);
			expect(sortedPaths(CODEQL.on.pull_request?.["paths-ignore"])).toEqual(canonical);
			expect(sortedPaths(CODEQL_SKIP.on.pull_request?.paths)).toEqual(canonical);
		});
	});
});
