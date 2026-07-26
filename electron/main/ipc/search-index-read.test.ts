// @vitest-environment node
//
// #412: index 取り込みに繋がる read が「末端 symlink を拒否する fd read」であることを
// **wiring レベルで** pin する。
//
// なぜ wiring を直接 pin するか: `IdleFillDeps.readFile` / dark assert の deps は型が
// `(p: string) => Promise<string>` でしかなく、plain `fsp.readFile` を注入しても型は通る。
// 契約は doc コメントにしか載らないため、production の wiring を revert する退行は
// deps を fake で差し替える既存 test では検出できない。
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { createCanonicalTempWorkspace, type TempWorkspace } from "../test-utils/temp-workspace";
import { __testing } from "./search";
import type { InvertedIndexHandle } from "./search-cache";

const { buildIdleFillDeps, readForReindex } = __testing;

// buildIdleFillDeps は index handle を素通しするだけなので、read 経路の pin には
// 最小の stub で足りる。
const stubIndex = {
	indexFile: () => {},
	currentEpochOf: () => 0,
	isIndexedAndValid: () => false,
	getCandidates: () => ({ kind: "fallback" }) as const,
	verify: () => {},
	collectViolations: () => null,
	get isDisabled(): boolean {
		return false;
	},
} satisfies InvertedIndexHandle;

describe.skipIf(process.platform === "win32")("index 取り込み read の wiring (#412)", () => {
	let ws: TempWorkspace;
	let outside: TempWorkspace;

	beforeEach(async () => {
		ws = await createCanonicalTempWorkspace("scripta-index-read-");
		outside = await createCanonicalTempWorkspace("scripta-index-read-out-");
	});

	afterEach(async () => {
		await ws.cleanup();
		await outside.cleanup();
	});

	it("idle fill の readFile は末端 symlink を拒否する", async () => {
		const secret = join(outside.dir, "secret.txt");
		await fsp.writeFile(secret, "SECRETWORD", "utf8");
		const swapped = join(ws.dir, "swapped.md");
		await fsp.symlink(secret, swapped);
		const normal = join(ws.dir, "normal.md");
		await fsp.writeFile(normal, "normal body", "utf8");

		const deps = buildIdleFillDeps(ws.dir, stubIndex);

		// 通常 file は従来どおり読める。
		await expect(deps.readFile(normal)).resolves.toBe("normal body");
		// 末端が symlink の file は reject する (呼び手の skipUntilEpochChange 経路に倒れる)。
		await expect(deps.readFile(swapped)).rejects.toThrow();
	});

	it("dark assert の再 index read は末端 symlink を拒否して null を返す", async () => {
		const secret = join(outside.dir, "secret.txt");
		await fsp.writeFile(secret, "SECRETWORD", "utf8");
		const swapped = join(ws.dir, "swapped.md");
		await fsp.symlink(secret, swapped);
		const normal = join(ws.dir, "normal.md");
		await fsp.writeFile(normal, "normal body", "utf8");

		// 読めない file は null = 「再検証できない」に倒す既存契約 (#405) は維持する。
		expect(await readForReindex(normal)).toBe("normal body");
		expect(await readForReindex(swapped)).toBeNull();
	});
});
