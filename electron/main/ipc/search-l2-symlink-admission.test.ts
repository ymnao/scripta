// @vitest-environment node
//
// L2 admission の symlink 抑止 (#416 Finding 1) を processMdFilesParallel 単体で固定する。
//
// #413 Finding 1 で「index が disabled なら realpath ゲートを skip する」ようにした結果、
// disabled workspace ではゲートが評価されず L2 への格納が無条件に通っていた。ここでは
// 「ゲートを評価しなかった read は lstat で非 symlink を確認してから L2 に載せる」不変条件と、
// **scan (検索結果) の契約は不変** = symlink の内容も従来どおり検索結果に出ることを pin する。
//
// path-guard は **mock しない** (実 realpath ゲートの挙動込みで固定する)。realpath 呼び出し回数を
// 数える search-index-gate.test.ts とはこの点で役割が違うためファイルを分けている。
import { promises as fsp } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { makeFakeCache, makeFakeIndex, never } from "../test-utils/search-fakes";
import { createCanonicalTempWorkspace, type TempWorkspace } from "../test-utils/temp-workspace";
import { __testing } from "./search";

const { processMdFilesParallel } = __testing;

let ws: TempWorkspace;
let root = "";
// workspace 外を指す symlink の target 置き場。
let outside: TempWorkspace;

beforeEach(async () => {
	// walk 結果と同じく canonical 側の path を使う (非 alias なら realpath は恒等)。
	ws = await createCanonicalTempWorkspace("scripta-l2-symlink-");
	root = ws.dir;
	outside = await createCanonicalTempWorkspace("scripta-l2-outside-");
});

afterEach(async () => {
	vi.restoreAllMocks();
	await ws.cleanup();
	await outside.cleanup();
});

describe.skipIf(process.platform === "win32")(
	"processMdFilesParallel: ゲート未評価 read の L2 symlink 抑止 (#416 Finding 1)",
	() => {
		it("index disabled: workspace 内 alias は L2 に載らないが scan 結果には出る", async () => {
			const real = join(root, "real.md");
			const link = join(root, "link.md");
			await writeFile(real, "alphaword body");
			await symlink(real, link);
			const { handle, indexed, disabled } = makeFakeIndex();
			disabled.value = true;
			const { cache, stored } = makeFakeCache();
			const scanned: string[] = [];

			await processMdFilesParallel([real, link], [real, link], never, {
				index: handle,
				indexRoot: root,
				cache,
				process: (inFile, text) => {
					scanned.push(`${inFile}:${text}`);
				},
			});

			// disabled なので index には何も載らない (#413 Finding 1、既存挙動)。
			expect(indexed.size).toBe(0);
			// alias は L2 に載らない: 解決先 (real.md) の modify では evict されないため、
			// 載せると L2 entry の寿命ぶん stale な内容が検索結果に出る。
			expect(stored.has(link)).toBe(false);
			// 実体は従来どおり L2 に載る (disabled workspace の L2 population を止めない)。
			expect(stored.get(real)).toBe("alphaword body");
			// **scan 契約は不変**: alias の内容も検索結果には出る (#399 の境界は
			// 「index に載せない」であって「検索結果に出さない」ではない)。
			expect(scanned.sort()).toEqual([`${link}:alphaword body`, `${real}:alphaword body`]);
		});

		it("index disabled: workspace 外を指す symlink も L2 に載らないが scan 結果には出る", async () => {
			const target = join(outside.dir, "secret.md");
			const link = join(root, "outside-link.md");
			await writeFile(target, "outside body");
			await symlink(target, link);
			const { handle, disabled } = makeFakeIndex();
			disabled.value = true;
			const { cache, stored } = makeFakeCache();
			const scanned: string[] = [];

			await processMdFilesParallel([link], [link], never, {
				index: handle,
				indexRoot: root,
				cache,
				process: (_inFile, text) => {
					scanned.push(text);
				},
			});

			// 外部内容が L2 に残ると、symlink を workspace 内へ swap back された後の
			// L2 hit + fresh ゲート pass で index へ流入する経路が復活する (#406)。
			expect(stored.size).toBe(0);
			expect(scanned).toEqual(["outside body"]);
		});

		it("index handle が無くても cache があれば symlink は L2 に載らない", async () => {
			// production では cache / index は同じ watcher entry 由来で必ず揃うが、
			// 内部 helper としては index だけ欠けた呼び出しもあり得る。抑止は
			// 「ゲートを評価しなかった」という条件だけで効くことを固定する。
			const real = join(root, "real.md");
			const link = join(root, "link.md");
			await writeFile(real, "alphaword body");
			await symlink(real, link);
			const { cache, stored } = makeFakeCache();

			await processMdFilesParallel([real, link], [real, link], never, {
				cache,
				process: () => {},
			});

			expect(stored.has(link)).toBe(false);
			expect(stored.get(real)).toBe("alphaword body");
		});

		it("indexRoot 未指定 (ゲート未評価) でも symlink は L2 に載らない", async () => {
			// indexRoot を渡さない caller が将来増えても admission が fail-open しないことを固定する
			// (#407 で追跡している fail-open の被害範囲を L2 側だけでも狭めておく)。
			const real = join(root, "real.md");
			const link = join(root, "link.md");
			await writeFile(real, "alphaword body");
			await symlink(real, link);
			const { handle } = makeFakeIndex();
			const { cache, stored } = makeFakeCache();

			await processMdFilesParallel([real, link], [real, link], never, {
				index: handle,
				cache,
				process: () => {},
			});

			expect(stored.has(link)).toBe(false);
			expect(stored.get(real)).toBe("alphaword body");
		});

		it("lstat が失敗したら fail-closed で L2 に載せない", async () => {
			const a = join(root, "a.md");
			await writeFile(a, "alpha");
			const { handle, disabled } = makeFakeIndex();
			disabled.value = true;
			const { cache, stored } = makeFakeCache();
			const scanned: string[] = [];
			vi.spyOn(fsp, "lstat").mockRejectedValue(new Error("EIO"));

			await processMdFilesParallel([a], [a], never, {
				index: handle,
				indexRoot: root,
				cache,
				process: (_inFile, text) => {
					scanned.push(text);
				},
			});

			// 判定不能なら載せない。被害は次回検索の read が 1 回増えることだけで、
			// scan 結果は L2 を経由しないので不変。
			expect(stored.size).toBe(0);
			expect(scanned).toEqual(["alpha"]);
		});
	},
);

describe("processMdFilesParallel: ゲート評価済み read は lstat を足さない (#416 Finding 1)", () => {
	it("index 有効 + 未 index の通常 file では lstat を呼ばずに L2 に載せる", async () => {
		// ゲート評価済みの枝は resolveInsideRoot が末端非 symlink まで確認済みなので、
		// 判定は indexable の再利用で足りる。正常系 (検索 hot path) の syscall 数が
		// 増えていないことをこの assert で守る。
		const a = join(root, "a.md");
		await writeFile(a, "alpha");
		const { handle, indexed } = makeFakeIndex();
		const { cache, stored } = makeFakeCache();
		const lstatSpy = vi.spyOn(fsp, "lstat");

		await processMdFilesParallel([a], [a], never, {
			index: handle,
			indexRoot: root,
			cache,
			process: () => {},
		});

		expect(lstatSpy).not.toHaveBeenCalled();
		expect(stored.get(a)).toBe("alpha");
		expect(indexed.get(a)).toBe("alpha");
	});

	it("index disabled の通常 file は lstat 経由でも従来どおり L2 に載る", async () => {
		// disabled workspace で L2 population が全停止すると検索が毎回全 file 再読になる。
		// 抑止対象は symlink だけであることを固定する。
		const a = join(root, "a.md");
		const b = join(root, "b.md");
		await writeFile(a, "alpha");
		await writeFile(b, "beta");
		const { handle, disabled } = makeFakeIndex();
		disabled.value = true;
		const { cache, stored } = makeFakeCache();

		await processMdFilesParallel([a, b], [a, b], never, {
			index: handle,
			indexRoot: root,
			cache,
			process: () => {},
		});

		expect(stored.get(a)).toBe("alpha");
		expect(stored.get(b)).toBe("beta");
	});
});
