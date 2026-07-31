// index 取り込み専用の read helper (#412)。
//
// **何を閉じるか**: `resolveInsideRoot` が返した path を後段の `fsp.readFile` で読むと、
// readFile が path を再 traversal するため「認可した実体」と「読んだ実体」がズレる窓が残る
// (resolve = T1、read = T2 の間に構成要素を symlink へ差し替えられる)。この helper は
// `O_NOFOLLOW` 付きで open した **fd から読む**ことで、少なくとも **末端 component** の
// swap を open 時点で検出して拒否する (ELOOP)。
//
// **何を閉じないか**: `O_NOFOLLOW` が効くのは末端 component だけで、**中間 dir の swap 窓は
// 残る**。これを閉じるには fd 相対の traversal (POSIX `openat` / Linux `openat2` の
// `RESOLVE_BENEATH`) が要るが、Node はどちらも expose していない。macOS には全 component で
// symlink を拒否する `O_NOFOLLOW_ANY` があるが、`fs.constants` に無く magic number
// (0x20000000) の直書きになる上に darwin 限定で保証が不均質になるため採らない
// (Node が constant を expose したら再検討する)。受容の全体像は path-guard.ts の
// `resolveInsideRoot` doc を参照。
//
// **正常系の挙動は変わらない**: 呼び手 (index 取り込み経路) は
// `isIndexableResolution(resolved, ioPath) === true`、すなわち `realpath(ioPath) === ioPath`
// を確認した path しか渡さない。末端が symlink でないことが確認済みなので、正常系で
// `O_NOFOLLOW` が発火することはない。発火する = 認可後に実際に swap が起きた瞬間であり、
// その file はもはや認可した実体と一致しないので **読まずに reject するのが正しい**。
//
// **syscall は増えない**: `fsp.readFile(path)` も内部で open/read/close するため、
// open flag を足して明示的に書き下しただけ。検索 hot path にコストは乗らない。
import { constants as fsConstants, promises as fsp } from "node:fs";

// Windows には `O_NOFOLLOW` が無い (`fs.constants` 上 undefined になり得る) ため 0 に落とす。
// その場合の保証は現状維持 = plain open 相当で、退行はしない。Windows の symlink 作成は
// 既定で管理者特権 (または開発者モード) を要するため、攻撃前提そのものが成立しにくい。
const NOFOLLOW_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * 末端 component が symlink なら reject する utf8 read (#412)。
 *
 * index 取り込みに繋がる read 経路 (piggyback / idle fill / dark assert の再 index) に加え、
 * **scan (検索結果) 用の read も #434 でこの helper に統一した**。scan 側は失敗を即 skip には
 * せず、`resolveInsideRoot` で解決し直して「workspace 内なら解決先を読む / 外なら落とす」に
 * 倒す (検索結果に出る集合を fs:read で開ける集合に揃えるため。詳細は
 * docs/adr/0011-search-visibility-follows-fs-read.md)。
 *
 * 失敗時は throw する (ELOOP / ENOENT / 権限エラー等を区別しない)。呼び手は「読み取り失敗
 * file は skip」か、上記 scan 側の解決し直しのどちらかに倒せばよい。
 */
export async function readFileUtf8NoFollow(path: string): Promise<string> {
	const fh = await fsp.open(path, NOFOLLOW_FLAGS);
	try {
		return await fh.readFile({ encoding: "utf8" });
	} finally {
		await fh.close();
	}
}
