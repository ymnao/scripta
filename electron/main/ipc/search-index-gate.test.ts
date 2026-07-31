// @vitest-environment node
//
// piggyback indexing のゲート (#413) を processMdFilesParallel 単体で固定する。
// - Finding 1: index が disabled なら realpath ゲート (resolveInsideRoot) を一切呼ばない。
// - Finding 2: 解決先が入力 path と異なる file (workspace 内 alias) は index / L2 に載せない。
//
// realpath 呼び出し回数を数えるため path-guard を partial mock する。mock は module 単位で
// 効くので、実 path-guard に依存する search.test.ts とは別ファイルに切る。
import { realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

vi.mock("../utils/path-guard", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../utils/path-guard")>();
	return {
		...actual,
		// 実挙動はそのままに呼び出し回数だけ観測する。
		resolveInsideRoot: vi.fn(actual.resolveInsideRoot),
	};
});

import { makeFakeCache, makeFakeIndex, never } from "../test-utils/search-fakes";
import { createTempWorkspace, type TempWorkspace } from "../test-utils/temp-workspace";

const actualPathGuard =
	await vi.importActual<typeof import("../utils/path-guard")>("../utils/path-guard");

import { resolveInsideRoot } from "../utils/path-guard";
import { __testing } from "./search";

const { processMdFilesParallel } = __testing;

let ws: TempWorkspace;
let root = "";

beforeEach(async () => {
	vi.mocked(resolveInsideRoot).mockClear();
	// 実挙動へ戻す (#412 の test が mockImplementation でゲートを騙すため)。
	vi.mocked(resolveInsideRoot).mockImplementation(actualPathGuard.resolveInsideRoot);
	ws = await createTempWorkspace("scripta-index-gate-");
	// walk 結果と同じく canonical 側の path を使う (非 alias なら resolved === ioPath)。
	root = await realpath(ws.dir);
});

afterEach(async () => {
	await ws.cleanup();
});

describe("processMdFilesParallel: index disabled ゲート (#413 Finding 1)", () => {
	it("L2-miss 経路: disabled ならゲートも indexFile も走らないが scan と L2 population は続く", async () => {
		const a = join(root, "a.md");
		const b = join(root, "b.md");
		await writeFile(a, "alpha");
		await writeFile(b, "beta");
		const { handle, indexed, disabled } = makeFakeIndex();
		disabled.value = true;
		const { cache, stored } = makeFakeCache(new Map());
		const scanned: string[] = [];

		await processMdFilesParallel([a, b], [a, b], never, {
			root,
			index: { handle },
			cache,
			process: (inFile, text) => {
				scanned.push(`${inFile}:${text}`);
			},
		});

		expect(vi.mocked(resolveInsideRoot)).not.toHaveBeenCalled();
		expect(indexed.size).toBe(0);
		// index を通らなくても scan (検索結果) は従来どおり全 file 分行われる。
		expect(scanned.sort()).toEqual([`${a}:alpha`, `${b}:beta`]);
		// **ゲート未評価の file は L2 に載せ続ける**。ここを止めると disabled workspace で
		// L2 population が全停止して検索が毎回全 file 再読になる。search.ts の
		// 「ゲート未評価の枝」全体が消える退行を殺すための assert (#416 Finding 1 の fix 後は
		// この枝が lstat 判定付きになったので、symlink 側の抑止は
		// search-l2-symlink-admission.test.ts が固定する)。
		expect(stored.size).toBe(2);
	});

	it("L2-hit 経路: disabled なら realpath ゲートも indexFile も走らない", async () => {
		const a = join(root, "a.md");
		await writeFile(a, "alpha on disk");
		const { handle, indexed, disabled } = makeFakeIndex();
		disabled.value = true;
		const { cache } = makeFakeCache(new Map([[a, "alpha cached"]]));
		const scanned: string[] = [];

		await processMdFilesParallel([a], [a], never, {
			root,
			index: { handle },
			cache,
			process: (_inFile, text) => {
				scanned.push(text);
			},
		});

		expect(vi.mocked(resolveInsideRoot)).not.toHaveBeenCalled();
		expect(indexed.size).toBe(0);
		expect(scanned).toEqual(["alpha cached"]);
	});

	it("disabled でなければ従来どおりゲートを通って index される (L2-miss / L2-hit 双方)", async () => {
		const a = join(root, "a.md");
		const b = join(root, "b.md");
		await writeFile(a, "alpha");
		await writeFile(b, "beta");
		const { handle, indexed } = makeFakeIndex();
		const { cache } = makeFakeCache(new Map([[b, "beta cached"]]));

		await processMdFilesParallel([a, b], [a, b], never, {
			root,
			index: { handle },
			cache,
			process: () => {},
		});

		expect(vi.mocked(resolveInsideRoot)).toHaveBeenCalledTimes(2);
		expect(indexed.get(a)).toBe("alpha"); // L2-miss 経路
		expect(indexed.get(b)).toBe("beta cached"); // L2-hit 経路
	});

	it("index.suppress: handle / root を渡しても index にもゲートにも触れない (#407 Finding 1/3)", async () => {
		// runDarkAssert の truth pass 用の抑止。`suppress` を無視する退行が入ると
		// (a) candidates 側で既に養った index を全走査側がもう一度養う二重化と
		// (b) ゲート未評価前提で read-only 化している L2 の扱い (search.ts の呼び出し側コメント)
		// の両方が崩れる。**旧 `suppressIndex` 時代からこの契約を固定する test は無く**
		// (#407 の refactor 中に mutation で survive したため追加)、
		// 型統合で `handle` / `root` を必ず併記する形になった今も挙動が同じことを併せて pin する。
		const a = join(root, "a.md");
		const b = join(root, "b.md");
		await writeFile(a, "alpha");
		await writeFile(b, "beta");
		const { handle, indexed } = makeFakeIndex();
		const { cache } = makeFakeCache(new Map([[b, "beta cached"]]));
		const scanned: string[] = [];

		await processMdFilesParallel([a, b], [a, b], never, {
			root,
			index: { handle, suppress: true },
			cache,
			process: (inFile, text) => {
				scanned.push(`${inFile}:${text}`);
			},
		});

		// index への副作用は L2-miss / L2-hit のどちらの経路からも起きない。
		expect(indexed.size).toBe(0);
		// suppress は「index を養わない」だけでなく「realpath ゲートも評価しない」を含む。
		expect(vi.mocked(resolveInsideRoot)).not.toHaveBeenCalled();
		// scan (truth pass の本来の目的) は従来どおり全 file 分行われる。
		expect(scanned.sort()).toEqual([`${a}:alpha`, `${b}:beta cached`]);
	});
});

// symlink 作成が要るので win32 では skip (既存の #406 suite と同方針)。
describe.skipIf(process.platform === "win32")(
	"processMdFilesParallel: alias は index / L2 に載せない (#413 Finding 2)",
	() => {
		it("L2-miss 経路: 解決先が入力 path と異なる file は indexFile も cache.set もしない", async () => {
			const real = join(root, "real.md");
			const link = join(root, "link.md");
			await writeFile(real, "alphaword body");
			await symlink(real, link);
			const { handle, indexed } = makeFakeIndex();
			const { cache, stored } = makeFakeCache(new Map());
			const scanned: string[] = [];

			await processMdFilesParallel([real, link], [real, link], never, {
				root,
				index: { handle },
				cache,
				process: (inFile, text) => {
					scanned.push(`${inFile}:${text}`);
				},
			});

			// 実体は従来どおり index / L2 に載る。
			expect(indexed.has(real)).toBe(true);
			expect(stored.has(real)).toBe(true);
			// alias は index にも L2 にも載らない。
			expect(indexed.has(link)).toBe(false);
			expect(stored.has(link)).toBe(false);
			// scan (検索結果) には従来どおり両方出る。
			expect(scanned.sort()).toEqual([`${link}:alphaword body`, `${real}:alphaword body`]);
		});

		it("L2-hit 経路: alias は cache hit しても indexFile しない", async () => {
			const real = join(root, "real.md");
			const link = join(root, "link.md");
			await writeFile(real, "alphaword body");
			await symlink(real, link);
			const { handle, indexed } = makeFakeIndex();
			const { cache } = makeFakeCache(new Map([[link, "alphaword cached"]]));
			const scanned: string[] = [];

			await processMdFilesParallel([link], [link], never, {
				root,
				index: { handle },
				cache,
				process: (_inFile, text) => {
					scanned.push(text);
				},
			});

			expect(indexed.has(link)).toBe(false);
			expect(scanned).toEqual(["alphaword cached"]);
		});
	},
);

// symlink 作成が要るので win32 では skip (既存 suite と同方針)。
describe.skipIf(process.platform === "win32")(
	"processMdFilesParallel: 認可後に末端が swap された file は読まない (#412)",
	() => {
		// TOCTOU の race そのものは再現せず、**swap された後の終状態**を作って決定的に検証する:
		// ゲート (resolveInsideRoot) には「入力 path と一致する = index 可」と答えさせつつ、
		// disk 上ではその path が workspace 外を指す symlink になっている状態。
		// これは T1 (認可) と T2 (read) の間に末端 component を差し替えられた直後と同じ。
		it("ゲートが index 可と答えても、disk 上の末端が symlink なら index にも L2 にも scan にも出さない", async () => {
			const outside = await createTempWorkspace("scripta-index-gate-outside-");
			try {
				const secret = join(outside.dir, "secret.txt");
				await writeFile(secret, "SECRETWORD body");
				const swapped = join(root, "swapped.md");
				await symlink(secret, swapped);
				const normal = join(root, "normal.md");
				await writeFile(normal, "normalword body");

				// 「認可 (T1) の時点では実体だった」= ゲートは入力 path をそのまま返す。
				vi.mocked(resolveInsideRoot).mockImplementation(async (ioPath: string) => ioPath);

				const { handle, indexed } = makeFakeIndex();
				const { cache, stored } = makeFakeCache(new Map());
				const scanned: string[] = [];

				await processMdFilesParallel([normal, swapped], [normal, swapped], never, {
					root,
					index: { handle },
					cache,
					process: (inFile, text) => {
						scanned.push(`${inFile}:${text}`);
					},
				});

				// 外部内容はどこにも流れない。
				expect(indexed.has(swapped)).toBe(false);
				expect(stored.has(swapped)).toBe(false);
				expect(scanned.join("\n")).not.toContain("SECRETWORD");
				// swap された file は read 失敗扱いで skip される (scan 結果からも落ちる)。
				// これは #412 で受け入れた挙動変化: 認可した実体と読める実体が一致しない以上、
				// 読まないのが正しい。**#434 以降は次の pass でも scan に出ない**: ゲートが
				// workspace 外 (resolveInsideRoot が null) と判定した file は非 indexable 経路で
				// skip されるため。つまりこの file の scan からの脱落は 1 pass 限りではなく、
				// swap が戻されるまで続く (#434 の「検索結果に出る = fs:read で開ける」の帰結で、
				// fs:read 側も同じ理由で拒否するため一貫している)。
				// **範囲**: processMdFilesParallel は検索だけでなく unresolved-wikilink scan /
				// backlink scan からも index options (handle + root) 付きで呼ばれるため、窓中はそれらの結果からも
				// 同じ 1 file が落ちる。影響の質は同一 (1 pass × 1 file) なので受容は変わらない。
				expect(scanned).toEqual([`${normal}:normalword body`]);
				// 巻き添えで通常 file が落ちていないこと (退行検知)。
				expect(indexed.get(normal)).toBe("normalword body");
				expect(stored.get(normal)).toBe("normalword body");
			} finally {
				await outside.cleanup();
			}
		});

		it("ゲート未評価経路でも workspace 外 symlink は落ち、realpath は symlink にしか乗らない", async () => {
			// ゲートが無い経路 (index 未提供 / index 無効 / 既に valid) でも #434 の境界は効く:
			// O_NOFOLLOW open の失敗で末端 symlink を検出し、そこで初めて realpath して
			// workspace 外なら scan からも落とす (旧契約では plain read で内容が結果に出ていた)。
			// **コストの pin も兼ねる**: 通常 file は O_NOFOLLOW open に成功するので realpath は
			// 呼ばれず、#413 Finding 1 で削った「全 file への realpath」は復活しない。
			// **#407 Finding 1/3 で削除した pin について**: 以前はここに「index はあるが indexRoot
			// 未指定」の case を置き、`useNoFollow` から `indexGateEvaluated` を落とす mutation を
			// 殺していた。root が必須プロパティになった今、index を持ちながらゲート未評価という
			// 状態は型上表現できず、その mutation は挙動を変えない
			// (index が無い ⇒ indexable === false ⇒ useNoFollow は元から false)。
			// runtime の pin が消えた分の保証は「root を省いた呼び出しは compile しない」= 型検査が
			// 担っており、それは search-index-options.test.ts の @ts-expect-error が固定している。
			const outside = await createTempWorkspace("scripta-index-gate-outside2-");
			try {
				const target = join(outside.dir, "target.txt");
				await writeFile(target, "OUTSIDEWORD body");
				const link = join(root, "link.md");
				await symlink(target, link);
				const normal = join(root, "normal.md");
				await writeFile(normal, "normalword body");
				const scanned: string[] = [];

				await processMdFilesParallel([link, normal], [link, normal], never, {
					root,
					process: (inFile, text) => {
						scanned.push(`${inFile}:${text}`);
					},
				});

				expect(scanned).toEqual([`${normal}:normalword body`]);
				// symlink の 1 件だけが realpath を払う (通常 file は 0 回)。
				expect(vi.mocked(resolveInsideRoot)).toHaveBeenCalledTimes(1);
				expect(vi.mocked(resolveInsideRoot)).toHaveBeenCalledWith(link, root);
			} finally {
				await outside.cleanup();
			}
		});
	},
);
