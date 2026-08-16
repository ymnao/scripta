import { constants as fsConstants, promises as fsp } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanonicalTempWorkspace, type TempWorkspace } from "../test-utils/temp-workspace";
import {
	NOFOLLOW_EMULATED,
	NOFOLLOW_READ_FLAGS,
	readFileUtf8NoFollow,
	rejectEndSymlinkWhenEmulated,
	writeFileAtomicNoFollow,
	writeFileUtf8NoFollow,
} from "./open-nofollow";

// #412: index 取り込み read の末端 swap 窓。
// TOCTOU の race そのものは再現せず、「認可後に swap された **終状態**」を disk 上に作って
// 決定的に検証する (interleave 不要)。
// symlink を張って ELOOP を assert するため win32 では skip (既存 suite と同方針)。
// win32 は O_NOFOLLOW が無く fallback で plain open 相当になるので、拒否 assert は成立しない。
describe.skipIf(process.platform === "win32")("readFileUtf8NoFollow", () => {
	let ws: TempWorkspace;
	let outside: TempWorkspace;

	beforeEach(async () => {
		ws = await createCanonicalTempWorkspace("scripta-nofollow-");
		outside = await createCanonicalTempWorkspace("scripta-nofollow-out-");
	});

	afterEach(async () => {
		await ws.cleanup();
		await outside.cleanup();
	});

	it("reads a regular file as utf8", async () => {
		const p = join(ws.dir, "note.md");
		await fsp.writeFile(p, "# hello\nマルチバイトも読める", "utf8");
		expect(await readFileUtf8NoFollow(p)).toBe("# hello\nマルチバイトも読める");
	});

	it("rejects a symlink pointing outside the workspace", async () => {
		const secret = join(outside.dir, "secret.txt");
		await fsp.writeFile(secret, "SECRET", "utf8");
		const link = join(ws.dir, "evil.md");
		await fsp.symlink(secret, link);

		// 主 assert は「reject されること」(= 外部内容が返らないこと)。errno も併せて固定する
		// (win32 は describe ごと skip しているので、残る darwin / linux では ELOOP で一致する)。
		const err = await readFileUtf8NoFollow(link).catch((e: NodeJS.ErrnoException) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as NodeJS.ErrnoException).code).toBe("ELOOP");
	});

	it("rejects an in-root symlink (alias) as well", async () => {
		const real = join(ws.dir, "real.md");
		await fsp.writeFile(real, "real body", "utf8");
		const alias = join(ws.dir, "alias.md");
		await fsp.symlink(real, alias);

		await expect(readFileUtf8NoFollow(alias)).rejects.toThrow();
		// 実体側は従来どおり読める (拒否対象は「末端が symlink である path」だけ)。
		expect(await readFileUtf8NoFollow(real)).toBe("real body");
	});

	it("rejects a missing file (呼び手の skip 契約に乗る)", async () => {
		await expect(readFileUtf8NoFollow(join(ws.dir, "nope.md"))).rejects.toThrow();
	});
});

// #418: 上書き write 版の helper と、read が flag だけ借りるための export 契約。
describe.skipIf(process.platform === "win32")("writeFileUtf8NoFollow / NOFOLLOW_FLAG", () => {
	let ws: TempWorkspace;

	beforeEach(async () => {
		ws = await createCanonicalTempWorkspace("scripta-nofollow-flag-");
	});

	afterEach(async () => {
		await ws.cleanup();
	});

	it("NOFOLLOW_READ_FLAGS は win32 以外で O_RDONLY 相当に落ちない", () => {
		// win32 fallback (`?? 0`) が効いた状態と区別する。O_RDONLY は 0 なので、
		// flag が落ちると読み取り専用 open と見分けが付かなくなる。
		expect(NOFOLLOW_READ_FLAGS).not.toBe(fsConstants.O_RDONLY);
	});

	it("末端 symlink への書き込みを拒否し、解決先を truncate もしない", async () => {
		const real = join(ws.dir, "real.md");
		await fsp.writeFile(real, "before", "utf8");
		const alias = join(ws.dir, "alias.md");
		await fsp.symlink(real, alias);

		const err = await writeFileUtf8NoFollow(alias, "after").catch((e: NodeJS.ErrnoException) => e);
		expect((err as NodeJS.ErrnoException).code).toBe("ELOOP");
		expect(await fsp.readFile(real, "utf8")).toBe("before");
	});

	it("通常 file は fsp.writeFile と同じく truncate + inode 保持で上書きする", async () => {
		const p = join(ws.dir, "note.md");
		// 長い内容 → 短い内容。O_TRUNC が抜けると旧内容の残骸が末尾に残るので、
		// この長さ関係でないと truncate の欠落を検出できない。
		await fsp.writeFile(p, "before マルチバイトの長い内容", "utf8");
		const before = await fsp.stat(p);

		await writeFileUtf8NoFollow(p, "after");

		expect(await fsp.readFile(p, "utf8")).toBe("after");
		expect((await fsp.stat(p)).ino).toBe(before.ino);
	});

	it("未存在の path は新規作成する", async () => {
		const p = join(ws.dir, "new.md");
		await writeFileUtf8NoFollow(p, "created");
		expect(await fsp.readFile(p, "utf8")).toBe("created");
	});
});

// #451: `O_NOFOLLOW` が無い platform (win32) 向けの拒否エミュレーション。
// **win32 実機では検証できない**ので、判定を `emulated` 引数として外から与え、
// platform 非依存に pin する。ここで固定できるのは「flag が落ちた platform だとしたら
// こう振る舞う」までで、win32 の fs semantics 自体 (O_NOFOLLOW が本当に undefined か /
// lstat が file symlink をどう報告するか) は windows runner でしか実測できない。
//
// helper への **配線**（`readFileUtf8NoFollow` / `writeFileUtf8NoFollow` が
// `rejectEndSymlinkWhenEmulated` を呼ぶこと）は、この describe では観測できない
// (emulation が off の platform では呼んでも呼ばなくても観測値が同じ)。配線は下の
// 「O_NOFOLLOW を落とした module」の describe が pin する。
describe.skipIf(process.platform === "win32")("rejectEndSymlinkWhenEmulated", () => {
	let ws: TempWorkspace;

	beforeEach(async () => {
		ws = await createCanonicalTempWorkspace("scripta-nofollow-emul-");
	});

	afterEach(async () => {
		await ws.cleanup();
	});

	it("この platform では emulation を使わない (lstat を払わない)", () => {
		// O_NOFOLLOW がある platform で emulation が有効化されると、検索 scan の全 `.md` に
		// lstat 1 回が恒常的に乗る。flag の有無と emulation の有無が連動していることを固定する。
		expect(NOFOLLOW_EMULATED).toBe(false);
	});

	it("emulated なら末端 symlink を ELOOP で拒否する", async () => {
		const real = join(ws.dir, "real.md");
		await fsp.writeFile(real, "body", "utf8");
		const alias = join(ws.dir, "alias.md");
		await fsp.symlink(real, alias);

		const err = await rejectEndSymlinkWhenEmulated(alias, true).catch(
			(e: NodeJS.ErrnoException) => e,
		);
		// errno まで固定するのは、呼び手 (search.ts の分岐 3 / git:resolve-conflict) が
		// O_NOFOLLOW の ELOOP と同じ形で受けられることが要件だから。
		expect((err as NodeJS.ErrnoException).code).toBe("ELOOP");
	});

	it("emulated でも通常 file は通す", async () => {
		const p = join(ws.dir, "note.md");
		await fsp.writeFile(p, "body", "utf8");
		await expect(rejectEndSymlinkWhenEmulated(p, true)).resolves.toBeUndefined();
	});

	it("emulated でも未存在 path は通す (open に判断を委ねる)", async () => {
		// ここで throw に倒すと `writeFileUtf8NoFollow` の新規作成が O_CREAT の open に
		// 到達できなくなる。lstat の失敗を拒否根拠にしないことを pin する。
		await expect(
			rejectEndSymlinkWhenEmulated(join(ws.dir, "nope.md"), true),
		).resolves.toBeUndefined();
	});

	it("emulated では ENOENT 以外の lstat 失敗を通さない", async () => {
		// 親が通常 file の path は lstat が ENOTDIR で落ちる。ここを握り潰すと「symlink か
		// どうか分からないまま open に進む」ので、ENOENT だけを通す narrowing を pin する。
		const file = join(ws.dir, "not-a-dir.md");
		await fsp.writeFile(file, "body", "utf8");

		const err = await rejectEndSymlinkWhenEmulated(join(file, "child.md"), true).catch(
			(e: NodeJS.ErrnoException) => e,
		);
		expect((err as NodeJS.ErrnoException).code).toBe("ENOTDIR");
	});

	it("emulated でなければ symlink でも拒否しない (判定は open 側の責務)", async () => {
		const real = join(ws.dir, "real2.md");
		await fsp.writeFile(real, "body", "utf8");
		const alias = join(ws.dir, "alias2.md");
		await fsp.symlink(real, alias);

		await expect(rejectEndSymlinkWhenEmulated(alias, false)).resolves.toBeUndefined();
	});
});

// #451: `fs.constants` から `O_NOFOLLOW` を落とした module を読み込み、**win32 と同じ
// 「flag が 0 に落ちた」状態**を POSIX 上で再現する。
//
// **これでしか pin できないもの**: helper 側の `rejectEndSymlinkWhenEmulated` 呼び出しを消す
// 変異は、実 `node:fs` の下 (emulation が off) では観測値を変えないので survive する。flag を
// 落とすと plain open が symlink read に成功してしまうため、配線の有無が初めて観測に出る
// = #451 の事故そのもの (「flag が落ちた platform で symlink の内容が読めてしまう」) を pin する。
describe.skipIf(process.platform === "win32")("O_NOFOLLOW を落とした module", () => {
	let ws: TempWorkspace;
	let outside: TempWorkspace;

	beforeEach(async () => {
		ws = await createCanonicalTempWorkspace("scripta-nofollow-drop-");
		outside = await createCanonicalTempWorkspace("scripta-nofollow-drop-out-");
	});

	afterEach(async () => {
		vi.doUnmock("node:fs");
		vi.resetModules();
		await ws.cleanup();
		await outside.cleanup();
	});

	// `O_NOFOLLOW` だけを undefined にした `node:fs` で module を読み直す。他の constant と
	// promises API は実物のままなので、観測される差は「flag が 0 に落ちたこと」だけになる。
	async function importWithoutNoFollow(): Promise<typeof import("./open-nofollow")> {
		vi.resetModules();
		vi.doMock("node:fs", async () => {
			const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
			return {
				...actual,
				constants: { ...actual.constants, O_NOFOLLOW: undefined },
			};
		});
		return await import("./open-nofollow");
	}

	it("flag が落ちると emulation が有効になる", async () => {
		const mod = await importWithoutNoFollow();
		expect(mod.NOFOLLOW_EMULATED).toBe(true);
		// plain open 相当に落ちたことも併せて固定する (この前提が崩れると以下の 2 件は
		// 「O_NOFOLLOW が効いたから拒否された」と区別できなくなる)。
		expect(mod.NOFOLLOW_READ_FLAGS).toBe(fsConstants.O_RDONLY);
	});

	it("readFileUtf8NoFollow が外部 symlink の内容を返さない", async () => {
		const secret = join(outside.dir, "secret.txt");
		await fsp.writeFile(secret, "SECRET", "utf8");
		const link = join(ws.dir, "evil.md");
		await fsp.symlink(secret, link);
		const mod = await importWithoutNoFollow();

		const err = await mod.readFileUtf8NoFollow(link).catch((e: NodeJS.ErrnoException) => e);
		// 配線が無いと plain open が follow して "SECRET" を返す = この assert が落ちる。
		expect((err as NodeJS.ErrnoException).code).toBe("ELOOP");
	});

	it("writeFileUtf8NoFollow が symlink の解決先を書き換えない", async () => {
		const real = join(ws.dir, "real.md");
		await fsp.writeFile(real, "before", "utf8");
		const alias = join(ws.dir, "alias.md");
		await fsp.symlink(real, alias);
		const mod = await importWithoutNoFollow();

		const err = await mod
			.writeFileUtf8NoFollow(alias, "after")
			.catch((e: NodeJS.ErrnoException) => e);
		expect((err as NodeJS.ErrnoException).code).toBe("ELOOP");
		expect(await fsp.readFile(real, "utf8")).toBe("before");
	});

	it("emulation 下でも通常 file の read / write は通る", async () => {
		const p = join(ws.dir, "note.md");
		const mod = await importWithoutNoFollow();

		await mod.writeFileUtf8NoFollow(p, "created");
		expect(await mod.readFileUtf8NoFollow(p)).toBe("created");
	});
});

// #455: inode 置換を伴う atomic write 版。`writeFileUtf8NoFollow` と違い ELOOP では
// 拒否せず、`rename(2)` が末端 symlink を follow しない性質で「認可した dir に着地する」
// ことを保証する。win32 は symlink を張る assert が成立しないので skip (既存 suite と同方針)。
describe.skipIf(process.platform === "win32")("writeFileAtomicNoFollow", () => {
	let ws: TempWorkspace;
	let outside: TempWorkspace;

	beforeEach(async () => {
		ws = await createCanonicalTempWorkspace("scripta-nofollow-atomic-");
		outside = await createCanonicalTempWorkspace("scripta-nofollow-atomic-out-");
	});

	afterEach(async () => {
		await ws.cleanup();
		await outside.cleanup();
	});

	it("末端が外部を指す symlink でも解決先を書き換えない (symlink 自身を置き換える)", async () => {
		const victim = join(outside.dir, "victim.pdf");
		await fsp.writeFile(victim, "ORIGINAL");
		const dest = join(ws.dir, "out.pdf");
		await fsp.symlink(victim, dest);

		await writeFileAtomicNoFollow(dest, Buffer.from("NEW"));

		// 主 assert: 外部の実体が無傷であること (escape が成立していないこと)。
		expect(await fsp.readFile(victim, "utf8")).toBe("ORIGINAL");
		// 副 assert: 書き込みは symlink 自身を通常 file で置き換えた形で着地する。
		expect((await fsp.lstat(dest)).isSymbolicLink()).toBe(false);
		expect(await fsp.readFile(dest, "utf8")).toBe("NEW");
	});

	it("既存 file を inode 置換で上書きする", async () => {
		const p = join(ws.dir, "out.pdf");
		await fsp.writeFile(p, "before の長い内容");
		const before = await fsp.stat(p);

		await writeFileAtomicNoFollow(p, Buffer.from("after"));

		expect(await fsp.readFile(p, "utf8")).toBe("after");
		expect((await fsp.stat(p)).ino).not.toBe(before.ino);
	});

	it("既存 file の permission を引き継ぐ (狭い側)", async () => {
		const p = join(ws.dir, "mode.pdf");
		await fsp.writeFile(p, "before");
		await fsp.chmod(p, 0o600);

		await writeFileAtomicNoFollow(p, Buffer.from("after"));

		expect((await fsp.stat(p)).mode & 0o777).toBe(0o600);
	});

	it("既存 file の permission を引き継ぐ (umask に削られる広い側)", async () => {
		// 0o600 側だけだと open の mode 引数で足りてしまい、書き込み後の chmod が消えても
		// 気付けない。umask に削られる mode を使うと chmod の欠落を検出できる。
		//
		// umask は ambient 依存 (CI は 022 だがコンテナでは 0 のこともある) なので、この test
		// 内で明示的に 022 を立てて復元する。固定しないと umask 0 の環境で chmod 無しでも
		// pass する vacuous test になる。
		const prevUmask = process.umask(0o022);
		try {
			const p = join(ws.dir, "mode-wide.pdf");
			await fsp.writeFile(p, "before");
			await fsp.chmod(p, 0o666);

			await writeFileAtomicNoFollow(p, Buffer.from("after"));

			expect((await fsp.stat(p)).mode & 0o777).toBe(0o666);
		} finally {
			process.umask(prevUmask);
		}
	});

	// **pin できていない性質**: 継承 mode を `open` 時点で渡していること (書き込み後の chmod
	// だけで狭めると、内容入りの tmp が一瞬広い mode で存在する窓ができる) は、**過渡状態**
	// なので最終状態の assert では区別できない。実際 `open` の mode 引数を落とす変異は上の
	// test 群を生き残る (mutation で確認済み)。tmp の mode を write 中に観測する手段が無い
	// ため、この性質は実装側のコメント (open-nofollow.ts) を根拠として受容する。

	it("末端が symlink なら mode を引き継がない (攻撃者に着地 file の mode を選ばせない)", async () => {
		const victim = join(outside.dir, "victim.pdf");
		await fsp.writeFile(victim, "ORIGINAL");
		await fsp.chmod(victim, 0o777);
		const dest = join(ws.dir, "wide.pdf");
		await fsp.symlink(victim, dest);

		await writeFileAtomicNoFollow(dest, Buffer.from("NEW"));

		expect((await fsp.stat(dest)).mode & 0o777).not.toBe(0o777);
		expect((await fsp.stat(victim)).mode & 0o777).toBe(0o777);
	});

	it("末端が dangling symlink でも symlink 自身を置き換える", async () => {
		// 認可時点で既に dangling だったケース (realpathBestEffort が祖先 fall-through して
		// symlink 自身の path を canonical として返す) の pin。
		const dest = join(ws.dir, "dangling.pdf");
		await fsp.symlink(join(outside.dir, "nope.pdf"), dest);

		await writeFileAtomicNoFollow(dest, Buffer.from("NEW"));

		expect((await fsp.lstat(dest)).isSymbolicLink()).toBe(false);
		expect(await fsp.readFile(dest, "utf8")).toBe("NEW");
		expect(await fsp.readdir(outside.dir)).toEqual([]);
	});

	it("未存在の path は新規作成し、tmp file を残さない", async () => {
		const p = join(ws.dir, "new.pdf");
		await writeFileAtomicNoFollow(p, Buffer.from("created"));
		expect(await fsp.readFile(p, "utf8")).toBe("created");
		expect(await fsp.readdir(ws.dir)).toEqual(["new.pdf"]);
	});

	it("rename に失敗しても tmp file を残さない", async () => {
		// destination が空でない dir なら tmp の作成と write までは成功し、rename だけが
		// 落ちる。tmp が既に disk 上にある状態で失敗させないと cleanup 経路を通らない
		// (open 自体が落ちるケースでは tmp が存在しないので、この assert は vacuous になる)。
		const p = join(ws.dir, "occupied");
		await fsp.mkdir(p);
		await fsp.writeFile(join(p, "child"), "keep", "utf8");

		await expect(writeFileAtomicNoFollow(p, Buffer.from("x"))).rejects.toThrow();

		expect(await fsp.readdir(ws.dir)).toEqual(["occupied"]);
		expect(await fsp.readFile(join(p, "child"), "utf8")).toBe("keep");
	});
});
