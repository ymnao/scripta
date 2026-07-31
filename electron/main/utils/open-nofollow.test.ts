import { constants as fsConstants, promises as fsp } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCanonicalTempWorkspace, type TempWorkspace } from "../test-utils/temp-workspace";
import { NOFOLLOW_FLAG, readFileUtf8NoFollow, writeFileUtf8NoFollow } from "./open-nofollow";

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

	it("NOFOLLOW_FLAG は win32 以外で 0 に落ちない (read 側が合成して使う)", () => {
		expect(NOFOLLOW_FLAG).not.toBe(0);
		// O_RDONLY は 0 なので、合成した値が flag そのものになることまで確認する
		expect(fsConstants.O_RDONLY | NOFOLLOW_FLAG).toBe(NOFOLLOW_FLAG);
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

	it("通常 file は fsp.writeFile と同じく inode を保って上書きする", async () => {
		const p = join(ws.dir, "note.md");
		await fsp.writeFile(p, "before", "utf8");
		const before = await fsp.stat(p);

		await writeFileUtf8NoFollow(p, "after マルチバイト");

		expect(await fsp.readFile(p, "utf8")).toBe("after マルチバイト");
		expect((await fsp.stat(p)).ino).toBe(before.ino);
	});

	it("未存在の path は新規作成する", async () => {
		const p = join(ws.dir, "new.md");
		await writeFileUtf8NoFollow(p, "created");
		expect(await fsp.readFile(p, "utf8")).toBe("created");
	});
});
