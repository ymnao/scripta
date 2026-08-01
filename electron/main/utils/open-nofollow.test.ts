import { constants as fsConstants, promises as fsp } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCanonicalTempWorkspace, type TempWorkspace } from "../test-utils/temp-workspace";
import {
	NOFOLLOW_READ_FLAGS,
	readFileUtf8NoFollow,
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
		// 0o600 側だけだと open の mode 引数で足りてしまい、書き込み後の chmod が
		// 消えても気付けない。既定 umask (022) に削られる 0o666 を使うと、chmod が
		// 無いと 0o644 になるので継承の両方向を pin できる。
		const p = join(ws.dir, "mode-wide.pdf");
		await fsp.writeFile(p, "before");
		await fsp.chmod(p, 0o666);

		await writeFileAtomicNoFollow(p, Buffer.from("after"));

		expect((await fsp.stat(p)).mode & 0o777).toBe(0o666);
	});

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
