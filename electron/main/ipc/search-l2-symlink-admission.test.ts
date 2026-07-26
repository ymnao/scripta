// @vitest-environment node
//
// L2 admission の symlink 抑止 (#416 Finding 1) を processMdFilesParallel 単体で固定する。
//
// #413 Finding 1 で「index が disabled なら realpath ゲートを skip する」ようにした結果、
// disabled workspace ではゲートが評価されず L2 への格納が無条件に通っていた。ここでは
// 「ゲートを評価しなかった read は O_NOFOLLOW open に成功した fd から読めたときだけ L2 に載せる」
// 不変条件 (= 検査した対象そのものから読む) と、
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
	},
);

describe("processMdFilesParallel: 判定手段を別 syscall に分けない (#416 Finding 1)", () => {
	it("admission 判定に lstat / stat を使わない (ゲート評価済み / 未評価とも)", async () => {
		// 判定を read と別の syscall で行うと、その 2 回の観測の間に対象を差し替えられる窓が
		// 開く (codex-review security の指摘)。判定は「O_NOFOLLOW open に成功した fd から
		// 読めたか」だけで表現し、lstat / stat 系は一切呼ばないことを固定する。
		const a = join(root, "a.md");
		const b = join(root, "b.md");
		await writeFile(a, "alpha");
		await writeFile(b, "beta");
		const gated = makeFakeIndex();
		const ungated = makeFakeIndex();
		ungated.disabled.value = true;
		const lstatSpy = vi.spyOn(fsp, "lstat");
		const statSpy = vi.spyOn(fsp, "stat");

		const first = makeFakeCache();
		await processMdFilesParallel([a], [a], never, {
			index: gated.handle,
			indexRoot: root,
			cache: first.cache,
			process: () => {},
		});
		const second = makeFakeCache();
		await processMdFilesParallel([b], [b], never, {
			index: ungated.handle,
			indexRoot: root,
			cache: second.cache,
			process: () => {},
		});

		expect(lstatSpy).not.toHaveBeenCalled();
		expect(statSpy).not.toHaveBeenCalled();
		// ゲート評価済みは従来どおり index と L2 の両方へ。
		expect(first.stored.get(a)).toBe("alpha");
		expect(gated.indexed.get(a)).toBe("alpha");
		// ゲート未評価は L2 のみ (disabled なので index には載らない)。
		expect(second.stored.get(b)).toBe("beta");
		expect(ungated.indexed.size).toBe(0);
	});

	it("index disabled の通常 file は fd 経路でも従来どおり L2 に載る", async () => {
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

	it("O_NOFOLLOW open が失敗したら L2 には載せず plain read で scan だけ続ける", async () => {
		// symlink 以外の理由 (EMFILE 等) で fd 経路が落ちても「検査済みの fd から読めていない」
		// ことに変わりはないので fail-closed に倒す。scan は plain read の fallback で従来どおり続く。
		const a = join(root, "a.md");
		await writeFile(a, "alpha");
		const { handle, disabled } = makeFakeIndex();
		disabled.value = true;
		const { cache, stored } = makeFakeCache();
		const scanned: string[] = [];
		vi.spyOn(fsp, "open").mockRejectedValue(new Error("EMFILE"));

		await processMdFilesParallel([a], [a], never, {
			index: handle,
			indexRoot: root,
			cache,
			process: (_inFile, text) => {
				scanned.push(text);
			},
		});

		expect(stored.size).toBe(0);
		expect(scanned).toEqual(["alpha"]);
	});
});
