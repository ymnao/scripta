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

	it("O_EXCL は既存 symlink を live / dangling とも EEXIST で拒否する", async () => {
		const target = join(dir, "target.md");
		await fsp.writeFile(target, "body", "utf8");
		const live = join(dir, "live.tmp");
		await fsp.symlink(target, live, "file");
		const dangling = join(dir, "dangling.tmp");
		await fsp.symlink(join(dir, "nope.md"), dangling, "file");

		const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
		for (const p of [live, dangling]) {
			const err = await fsp.open(p, flags).then(
				async (fh) => {
					await fh.close();
					return null;
				},
				(e: NodeJS.ErrnoException) => e,
			);
			expect(err?.code).toBe("EEXIST");
		}
	});
});
