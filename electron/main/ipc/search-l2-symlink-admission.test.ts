// @vitest-environment node
//
// L2 admission の symlink 抑止 (#416 Finding 1) と、**検索結果の可視範囲** (#434) を
// processMdFilesParallel 単体で固定する。
//
// #413 Finding 1 で「index が disabled なら realpath ゲートを skip する」ようにした結果、
// disabled workspace ではゲートが評価されず L2 への格納が無条件に通っていた。ここでは
// 「ゲートを評価しなかった read は O_NOFOLLOW open に成功した fd から読めたときだけ L2 に載せる」
// 不変条件 (= 検査した対象そのものから読む) を pin する。
//
// **scan (検索結果) の契約は #434 で変わった**: 旧契約は「認可の境界は index に載せないこと
// であって検索結果に出さないことではない」で、workspace 外を指す symlink の内容も結果に出て
// いた。しかしその file は fs:read (assertPathAllowed) が realpath 解決して拒否するため、
// ユーザーには「検索結果に本文が出るのにクリックすると開けない」状態だった。現契約は
// **「検索結果に出る = fs:read で開ける」** で、workspace 外を指す symlink は結果からも落ちる。
// workspace 内 alias は fs:read で開けるので従来どおり結果に出る (内容は解決先から読む)。
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
				root,
				index: { handle },
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
			// alias の内容は検索結果には出る (#434): 解決先が root 内なので fs:read でも開ける。
			expect(scanned.sort()).toEqual([`${link}:alphaword body`, `${real}:alphaword body`]);
		});

		it("index disabled: workspace 外を指す symlink は L2 にも scan 結果にも出ない", async () => {
			const target = join(outside.dir, "secret.md");
			const link = join(root, "outside-link.md");
			await writeFile(target, "outside body");
			await symlink(target, link);
			const { handle, disabled } = makeFakeIndex();
			disabled.value = true;
			const { cache, stored } = makeFakeCache();
			const scanned: string[] = [];

			await processMdFilesParallel([link], [link], never, {
				root,
				index: { handle },
				cache,
				process: (_inFile, text) => {
					scanned.push(text);
				},
			});

			// 外部内容が L2 に残ると、symlink を workspace 内へ swap back された後の
			// L2 hit + fresh ゲート pass で index へ流入する経路が復活する (#406)。
			expect(stored.size).toBe(0);
			// #434: 検索結果からも落とす。この file は fs:read が realpath 解決して拒否するため、
			// 結果に出しても開けない (旧契約はこの「出るが開けない」状態を許容していた)。
			expect(scanned).toEqual([]);
		});

		it("index handle が無くても cache があれば symlink は L2 に載らない", async () => {
			// production では cache / index は同じ watcher entry 由来で必ず揃うが、
			// 内部 helper としては index だけ欠けた呼び出しもあり得る。抑止は
			// 「ゲートを評価しなかった」という条件だけで効くことを固定する。
			// #407 Finding 1/3 以前は「index はあるが indexRoot 未指定」でも同じ経路に落ちるため
			// 専用 case を別に持っていたが、root が必須プロパティになりその状態が型上
			// 表現できなくなったので、ゲート未評価経路の pin はこの case に一本化した。
			const real = join(root, "real.md");
			const link = join(root, "link.md");
			await writeFile(real, "alphaword body");
			await symlink(real, link);
			const { cache, stored } = makeFakeCache();

			await processMdFilesParallel([real, link], [real, link], never, {
				root,
				cache,
				process: () => {},
			});

			expect(stored.has(link)).toBe(false);
			expect(stored.get(real)).toBe("alphaword body");
		});
	},
);

describe.skipIf(process.platform === "win32")(
	"processMdFilesParallel: 検索結果に出る = fs:read で開ける (#434)",
	() => {
		// cache も index も渡さない純 scan 経路 (watcher 非稼働 workspace 相当)。
		// #434 以前はこの経路だけが plain read のままで、O_NOFOLLOW を通らず
		// workspace 外の内容が無条件に結果へ出ていた。
		// **この経路で workspace 外 symlink が落ちること自体の pin は
		// search-index-gate.test.ts の「ゲート未評価経路でも workspace 外 symlink は落ち、
		// realpath は symlink にしか乗らない」に一本化してある** (あちらは realpath の
		// 呼び出し回数まで assert してコスト特性も同時に固定するため上位互換)。
		// ここでは同経路で **落ちない側** (in-root alias / 通常 file) を固定する。
		it("cache / index 無しの純 scan でも in-root alias は alias の path で結果に出る", async () => {
			// alias が結果から落ちないこと (= #434 が落とすのは workspace 外だけ) と、
			// 報告される path が解決先ではなく **入力の alias path** であることを固定する
			// (renderer は workspacePath 起点の表記で tab を開くため)。
			const real = join(root, "real.md");
			const link = join(root, "link.md");
			await writeFile(real, "alphaword body");
			await symlink(real, link);
			const scanned: string[] = [];

			await processMdFilesParallel([link], [link], never, {
				root,
				process: (inFile, text) => {
					scanned.push(`${inFile}:${text}`);
				},
			});

			expect(scanned).toEqual([`${link}:alphaword body`]);
		});

		it("ゲート評価済み経路でも workspace 外を指す symlink は結果に出ない", async () => {
			// index が有効な通常経路 (ゲート評価済み ∧ 非 indexable)。ゲートが既に realpath 済みなので
			// 追加 syscall なしで判定でき、O_NOFOLLOW open すら試さずに skip する。
			const target = join(outside.dir, "secret.md");
			const link = join(root, "outside-link.md");
			await writeFile(target, "outside body");
			await symlink(target, link);
			const { handle, indexed } = makeFakeIndex();
			const { cache, stored } = makeFakeCache();
			const scanned: string[] = [];

			await processMdFilesParallel([link], [link], never, {
				root,
				index: { handle },
				cache,
				process: (_inFile, text) => {
					scanned.push(text);
				},
			});

			expect(indexed.size).toBe(0);
			expect(stored.size).toBe(0);
			expect(scanned).toEqual([]);
		});

		it("L2 hit でもゲートを評価した pass なら workspace 外 symlink は結果に出ない", async () => {
			// 「通常 file として L2 に載った後、watcher が拾えない retarget で workspace 外
			// symlink 化した」状態。L2 hit なので read は起きず、内容は認可済みだった過去の実体
			// (= 情報漏洩ではない) だが、その path は今 fs:read が拒否するので結果に出しても
			// 開けない。ゲートが払った realpath を可視範囲判定にも使って落とす。
			const target = join(outside.dir, "secret.md");
			const link = join(root, "was-normal.md");
			await writeFile(target, "outside body");
			await symlink(target, link);
			const { handle, indexed } = makeFakeIndex();
			// retarget 前に載った L2 entry を模す (内容は workspace 内だった頃のもの)。
			const { cache, stored } = makeFakeCache(new Map([[link, "alphaword old inside body"]]));
			const scanned: string[] = [];

			await processMdFilesParallel([link], [link], never, {
				root,
				index: { handle },
				cache,
				process: (_inFile, text) => {
					scanned.push(text);
				},
			});

			expect(scanned).toEqual([]);
			// index にも入らない (ゲートが null を返す従来どおりの抑止)。
			expect(indexed.size).toBe(0);
			// L2 hit 経路なので set は呼ばれない (退行検知: 落とす実装が set を挟んでいないこと)。
			expect(stored.size).toBe(0);
		});

		it("dangling symlink は結果に出ず throw もしない", async () => {
			// realpath が解決できない = resolveInsideRoot が null。workspace 外と同じ skip に倒れる
			// (旧経路では plain read が ENOENT で失敗して skip されており、結果は変わらない)。
			const link = join(root, "dangling.md");
			await symlink(join(root, "missing-target.md"), link);
			const real = join(root, "real.md");
			await writeFile(real, "alphaword body");
			const scanned: string[] = [];

			await processMdFilesParallel([link, real], [link, real], never, {
				root,
				process: (inFile, text) => {
					scanned.push(`${inFile}:${text}`);
				},
			});

			// dangling だけが落ち、同じ pass の通常 file は影響を受けない。
			expect(scanned).toEqual([`${real}:alphaword body`]);
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
			root,
			index: { handle: gated.handle },
			cache: first.cache,
			process: () => {},
		});
		const second = makeFakeCache();
		await processMdFilesParallel([b], [b], never, {
			root,
			index: { handle: ungated.handle },
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
			root,
			index: { handle },
			cache,
			process: () => {},
		});

		expect(stored.get(a)).toBe("alpha");
		expect(stored.get(b)).toBe("beta");
	});

	it("O_NOFOLLOW open が失敗した通常 file は L2 に載せず解決先 read で scan だけ続ける", async () => {
		// symlink 以外の理由 (EMFILE 等) で fd 経路が落ちても「検査済みの fd から読めていない」
		// ことに変わりはないので L2 は fail-closed に倒す。一方 scan は #434 の fallback
		// (resolveInsideRoot → 非 null なら解決先 read) で従来どおり続く。通常 file の realpath は
		// 恒等なので、落ちるのは workspace 外 / 解決不能だけであることをここで固定する。
		const a = join(root, "a.md");
		await writeFile(a, "alpha");
		const { handle, disabled } = makeFakeIndex();
		disabled.value = true;
		const { cache, stored } = makeFakeCache();
		const scanned: string[] = [];
		vi.spyOn(fsp, "open").mockRejectedValue(new Error("EMFILE"));

		await processMdFilesParallel([a], [a], never, {
			root,
			index: { handle },
			cache,
			process: (_inFile, text) => {
				scanned.push(text);
			},
		});

		expect(stored.size).toBe(0);
		expect(scanned).toEqual(["alpha"]);
	});
});
