// #500: win32 の fs semantics を実機で測る probe。#451 で入れた `O_NOFOLLOW` 不在時の
// エミュレーションは、それまで「flag が落ちた platform だとしたらこう振る舞う」までしか
// pin できておらず、win32 の fs semantics 自体は 1 つも実測されていなかった。
//
// **Why not 既存 test の un-skip**: `open-nofollow.test.ts` / `path-guard.test.ts` の
// symlink 系は open 由来の ELOOP・`stat().ino` の同一性・mode 継承といった POSIX 前提の
// assertion で書かれており、win32 では拒否経路が emulation (lstat) に替わるため
// assertion 側の platform 分岐が広範囲に要る。ここでは測りたい前提だけを独立に置く。
//
// **Why not skip**: symlink 作成が特権エラーで落ちたときに skip すると、
// 「測れなかった」が「測って問題なかった」と区別できない vacuous pass になる。
// `fsp.symlink` は握らずそのまま await し、失敗はこの file の失敗として出す。
import { constants as fsConstants, promises as fsp } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeCanonicalTempDir } from "../test-utils/temp-workspace";
import {
	NOFOLLOW_EMULATED,
	readFileUtf8NoFollow,
	rejectEndSymlinkWhenEmulated,
	writeFileAtomicNoFollow,
	writeFileUtf8NoFollow,
} from "./open-nofollow";

describe.skipIf(process.platform !== "win32")("win32 の fs semantics 実測 (#500)", () => {
	let dir: string;
	const dirsToCleanup: string[] = [];

	beforeEach(async () => {
		dir = await makeCanonicalTempDir("scripta-win32-probe-");
		dirsToCleanup.push(dir);
	});

	afterEach(async () => {
		// Windows は close 済み handle の解放が遅延しうる。`createCanonicalTempWorkspace` の
		// cleanup は maxRetries を渡さないので、git.test.ts の先例に合わせて自前で消す
		// (infra 由来の EPERM / EBUSY を probe の赤にしないため)。
		// 配列経由なのは、mkdtemp 自体が失敗した回で未代入の dir を rm に渡さないため
		// (probe が出したい一次エラーに TypeError が重なる)。
		for (const d of dirsToCleanup.splice(0)) {
			await fsp.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	});

	async function createFileSymlink(): Promise<{ target: string; link: string }> {
		const target = join(dir, "target.md");
		await fsp.writeFile(target, "body", "utf8");
		const link = join(dir, "link.md");
		await fsp.symlink(target, link, "file");
		return { target, link };
	}

	it("O_NOFOLLOW は undefined で、emulation 経路が選ばれる", () => {
		expect(fsConstants.O_NOFOLLOW).toBeUndefined();
		expect(NOFOLLOW_EMULATED).toBe(true);
	});

	it("lstat は file symlink を isSymbolicLink()=true で報告する", async () => {
		const { link } = await createFileSymlink();

		const st = await fsp.lstat(link);
		expect(st.isSymbolicLink()).toBe(true);
		expect(st.isFile()).toBe(false);
	});

	it("plain open は file symlink を follow して解決先の内容を返す", async () => {
		const { link } = await createFileSymlink();

		const fh = await fsp.open(link, "r");
		try {
			expect(await fh.readFile({ encoding: "utf8" })).toBe("body");
		} finally {
			await fh.close();
		}
	});

	it("directory junction は readdir で isDirectory()=false / isSymbolicLink()=true になる", async () => {
		const outside = join(dir, "outside");
		await fsp.mkdir(outside);
		await fsp.writeFile(join(outside, "leaked.md"), "leaked", "utf8");
		const root = join(dir, "root");
		await fsp.mkdir(root);
		await fsp.symlink(outside, join(root, "junction"), "junction");

		const entries = await fsp.readdir(root, { withFileTypes: true });
		const junction = entries.find((e) => e.name === "junction");
		expect(junction).toBeDefined();
		// search.ts の walkMdFiles は `ent.isDirectory()` でのみ再帰する。ここが true だと
		// junction 経由で workspace 外の tree が検索結果に混入する。
		expect(junction?.isDirectory()).toBe(false);
		expect(junction?.isSymbolicLink()).toBe(true);
	});

	it("readFileUtf8NoFollow は末端 symlink を ELOOP で拒否する", async () => {
		const { link } = await createFileSymlink();

		const err = await readFileUtf8NoFollow(link).then(
			() => null,
			(e: NodeJS.ErrnoException) => e,
		);
		expect(err?.code).toBe("ELOOP");
	});

	it("writeFileUtf8NoFollow は末端 symlink を ELOOP で拒否し解決先を書き換えない", async () => {
		const { target, link } = await createFileSymlink();

		const err = await writeFileUtf8NoFollow(link, "overwritten").then(
			() => null,
			(e: NodeJS.ErrnoException) => e,
		);
		expect(err?.code).toBe("ELOOP");
		expect(await fsp.readFile(target, "utf8")).toBe("body");
	});

	// `writeFileAtomicNoFollow` は ELOOP 拒否ではなく rename(2) / O_EXCL の semantics に
	// 乗って境界を保つ (open-nofollow.ts の doc)。その根拠は POSIX の probe でしか
	// 確かめられておらず、win32 の rename は MoveFileEx 系の別実装なので自動では移送されない。
	// pdf:export として Windows にも出荷される経路なのでここで測る。
	it("rename は destination の末端 symlink を follow せず symlink 自身を置き換える", async () => {
		const outside = join(dir, "outside.md");
		await fsp.writeFile(outside, "outside body", "utf8");
		const link = join(dir, "export.pdf");
		await fsp.symlink(outside, link, "file");

		await writeFileAtomicNoFollow(link, Buffer.from("landed"));

		expect(await fsp.readFile(outside, "utf8")).toBe("outside body");
		expect((await fsp.lstat(link)).isSymbolicLink()).toBe(false);
		expect(await fsp.readFile(link, "utf8")).toBe("landed");
	});

	// live / dangling を 1 本にまとめると、どちらが割れたのかが結果から読めない
	// (実際に 1 度まとめて書いて読めなかった)。probe の目的は差の同定なので分ける。
	async function openExclusive(path: string): Promise<NodeJS.ErrnoException | null> {
		const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
		return fsp.open(path, flags).then(
			async (fh) => {
				await fh.close();
				return null;
			},
			(e: NodeJS.ErrnoException) => e,
		);
	}

	it("O_EXCL は live な既存 symlink を EEXIST で拒否する", async () => {
		const { link } = await createFileSymlink();

		expect((await openExclusive(link))?.code).toBe("EEXIST");
	});

	// **実測が POSIX と割れた唯一の前提** (#504)。Windows は reparse point を follow した
	// うえで「解決先が無い」ため CREATE_NEW が通り、解決先に file が作られる。
	// open-nofollow.ts が「symlink であっても EEXIST」と書いていた根拠はここで崩れる。
	// **これは raw な syscall semantics の pin**で、production 側はこの semantics に乗るのを
	// やめ、create 系 3 経路に `rejectEndSymlinkWhenEmulated` を前置する判断になった (#504)。
	// 下の「create 系は…」がその guard 後の実測。
	it("O_EXCL は dangling な既存 symlink を拒否せず解決先に file を作る", async () => {
		const resolved = join(dir, "nope.md");
		const dangling = join(dir, "dangling.tmp");
		await fsp.symlink(resolved, dangling, "file");

		expect(await openExclusive(dangling)).toBeNull();
		expect((await fsp.lstat(resolved)).isFile()).toBe(true);
	});

	// 非 recursive な `mkdir` は `fs:create-directory` が「既存なら EEXIST」を atomic に得る
	// ために使っている。`O_EXCL` とは別 syscall (CreateDirectory) なので上の実測からは移送
	// されない。live / dangling を分けるのは、割れたときにどちらか読めるようにするため。
	it("非 recursive mkdir は live な既存 symlink を EEXIST で拒否する", async () => {
		const target = join(dir, "target-dir");
		await fsp.mkdir(target);
		const link = join(dir, "link-dir");
		await fsp.symlink(target, link, "junction");

		const err = await fsp.mkdir(link).then(
			() => null,
			(e: NodeJS.ErrnoException) => e,
		);
		expect(err?.code).toBe("EEXIST");
	});

	it("非 recursive mkdir は dangling な既存 symlink をどう扱うか", async () => {
		const resolved = join(dir, "nope-dir");
		const dangling = join(dir, "dangling-dir");
		await fsp.symlink(resolved, dangling, "junction");

		// 期待値は「`O_EXCL` と同じく follow して解決先を作る」側に置く。実測が EEXIST なら
		// この it が赤くなり、それが実測結果になる (production は guard 前置で確定済みなので
		// どちらでも判断は動かない)。
		const err = await fsp.mkdir(dangling).then(
			() => null,
			(e: NodeJS.ErrnoException) => e,
		);
		expect(err).toBeNull();
		expect((await fsp.lstat(resolved)).isDirectory()).toBe(true);
	});

	// create 系 3 経路に前置した guard の土台 (#504)。上の「lstat は file symlink を…」は
	// **live** な symlink でしか測っておらず、guard が塞ぐ相手は **dangling** の方なので別に測る。
	// 呼び手側の配線 (fs.ts の 3 経路が guard を呼ぶこと) は darwin の
	// 「O_NOFOLLOW を落とした module」が pin する。既定引数のまま呼ぶことで、win32 実機で
	// `NOFOLLOW_EMULATED` が拒否側に倒れていることも同時に観測する。
	it("rejectEndSymlinkWhenEmulated は dangling symlink も ELOOP で拒否する", async () => {
		const dangling = join(dir, "dangling-guard.md");
		await fsp.symlink(join(dir, "nope-guard.md"), dangling, "file");

		const err = await rejectEndSymlinkWhenEmulated(dangling).then(
			() => null,
			(e: NodeJS.ErrnoException) => e,
		);
		expect(err?.code).toBe("ELOOP");
	});

	// `fs:create-directory` の末端に置かれうるのは file symlink ではなく junction の方
	// (win32 で無特権に作れる)。lstat が junction をどう報告するかは上の readdir の実測
	// (Dirent は別 syscall) からは移送されないので、guard の土台として別に測る。
	it("rejectEndSymlinkWhenEmulated は dangling junction も ELOOP で拒否する", async () => {
		const dangling = join(dir, "dangling-junction");
		await fsp.symlink(join(dir, "nope-junction"), dangling, "junction");

		const err = await rejectEndSymlinkWhenEmulated(dangling).then(
			() => null,
			(e: NodeJS.ErrnoException) => e,
		);
		expect(err?.code).toBe("ELOOP");
	});

	// **末端ではなく親**が dangling の場合の recursive mkdir。これが follow して解決先に dir を
	// 作ると親が live 化し、末端の guard は ENOENT で素通りする (= 認可済み root の外へ着地しうる)。
	// 影響は create 系 3 経路に閉じない: 同じ `mkdir(dirname, {recursive:true})` は `fs:write` /
	// `fs:rename` / `git:resolve-conflict` も通り、末端 guard の有無に関わらず同型になる。
	// production 側の判断はこの実測を見てから (末端 symlink とは別クラスなので本 PR の scope 外)。
	// darwin では ENOTDIR で失敗し解決先に何も作られない (scratchpad の node probe で実測)。
	// win32 は未実測なのでここで測る。期待値は「follow して作る」側 (`O_EXCL` / CREATE_NEW と
	// 同系) に置く。赤くなれば win32 も POSIX 側だったという実測結果になる。
	it("親が dangling symlink のときの recursive mkdir をどう扱うか", async () => {
		const outsideParent = join(dir, "outside-parent");
		const linkParent = join(dir, "link-parent");
		await fsp.symlink(outsideParent, linkParent, "junction");

		const err = await fsp.mkdir(join(linkParent, "child"), { recursive: true }).then(
			() => null,
			(e: NodeJS.ErrnoException) => e,
		);
		expect(err).toBeNull();
		expect((await fsp.lstat(join(outsideParent, "child"))).isDirectory()).toBe(true);
	});
});
