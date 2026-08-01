// 末端 component の symlink follow を閉じる open flag と、その flag を使う I/O helper
// (#412 / #418 / #455)。
//
// **何を閉じるか**: 認可 (`resolveInsideRoot` / `assertPathAllowed`) が返した path を後段の
// `fsp.readFile` / `fsp.writeFile` に渡すと、その API が path を再 traversal するため
// 「認可した実体」と「読み書きした実体」がズレる窓が残る (認可 = T1、I/O = T2 の間に
// 構成要素を symlink へ差し替えられる)。`O_NOFOLLOW` 付きで open した **fd に対して I/O する**
// ことで、少なくとも **末端 component** の swap を open 時点で検出して拒否する (ELOOP)。
//
// **何を閉じないか**: `O_NOFOLLOW` が効くのは末端 component だけで、**中間 dir の swap 窓は
// 残る**。これを閉じるには fd 相対の traversal (POSIX `openat` / Linux `openat2` の
// `RESOLVE_BENEATH`) が要るが、Node はどちらも expose していない。macOS には全 component で
// symlink を拒否する `O_NOFOLLOW_ANY` があるが、`fs.constants` に無く magic number
// (0x20000000) の直書きになる上に darwin 限定で保証が不均質になるため採らない
// (Node が constant を expose したら再検討する)。受容の全体像は path-guard.ts の
// `resolveInsideRoot` doc を参照。
//
// **正常系の挙動は変わらない**: どの呼び手も「末端が symlink でない」ことを確認済みの path
// しか渡さない (index 取り込み経路は `isIndexableResolution(resolved, ioPath) === true`、
// すなわち `realpath(ioPath) === ioPath` を確認した path。user-IPC 経路は path-guard の
// assert 系が返す canonical で、根拠は fs.ts の doc を参照)。したがって発火する = 認可後に
// 実際に swap が起きた瞬間であり、その file はもはや認可した実体と一致しないので
// **読み書きせずに reject するのが正しい**。
//
// **syscall は増えない**: `fsp.readFile(path)` / `fsp.writeFile(path)` も内部で
// open/read(write)/close するため、open flag を足して明示的に書き下しただけ。検索 hot path
// にも editor の保存経路にもコストは乗らない。
//
// **atomic write だけは別機構**: inode 置換が要る呼び手 (pdf:export) は `O_NOFOLLOW` open では
// なく `rename(2)` が末端 symlink を follow しない性質に乗る (`writeFileAtomicNoFollow`)。
//
// **適用範囲**: path-guard (`assertPathAllowed` / `assertWritePathAllowed`) を通る write 経路
// (fs.ts / pdf.ts / git.ts) がこの module を使う。userData 配下に書く settings.ts /
// window-state.ts は path-guard を通らず renderer 由来 path も受けないため、引き続き
// `write-file-atomic` を使う。
import { randomBytes } from "node:crypto";
import { constants as fsConstants, promises as fsp } from "node:fs";
import { basename, dirname, join } from "node:path";

// Windows には `O_NOFOLLOW` が無い (`fs.constants` 上 undefined になり得る) ため 0 に落とす。
// その場合の保証は現状維持 = plain open 相当で、退行はしない。Windows の symlink 作成は
// 既定で管理者特権 (または開発者モード) を要するため、攻撃前提そのものが成立しにくい。
// **Windows でこの flag が無効になる帰結**は #451 で追跡している。
//
// `?? 0` の fallback 知識と access mode との合成をこの module に閉じ込める。呼び手は
// `fsConstants.O_NOFOLLOW` を直接参照せず、下の helper か `NOFOLLOW_READ_FLAGS` を使う。
const NOFOLLOW_FLAG = fsConstants.O_NOFOLLOW ?? 0;

// `fsp.open(path, "r")` と同じ access mode に O_NOFOLLOW を足したもの。fd 自体を必要とする
// 呼び手 (fs.ts の bounded read / base64 変換) が open flag として使う。
export const NOFOLLOW_READ_FLAGS = fsConstants.O_RDONLY | NOFOLLOW_FLAG;
// `fsp.writeFile` の既定 flag `"w"` と同じ access mode に O_NOFOLLOW を足したもの。
const NOFOLLOW_OVERWRITE_FLAGS =
	fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NOFOLLOW_FLAG;
// tmp file 作成用。`O_EXCL` は既存 entry があれば **symlink であっても** EEXIST で落ちる
// (POSIX 規定。probe で live / dangling とも EEXIST を確認済み) ので、tmp 名が衝突しても
// 攻撃者が仕込んだ symlink を掴まされることはない。`O_NOFOLLOW` は冗長だが、この module の
// 他の flag と揃えて「follow しない」意図を flag 側にも残す。
const NOFOLLOW_CREATE_EXCLUSIVE_FLAGS =
	fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW_FLAG;

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
	const fh = await fsp.open(path, NOFOLLOW_READ_FLAGS);
	try {
		return await fh.readFile({ encoding: "utf8" });
	} finally {
		await fh.close();
	}
}

/**
 * 末端 component が symlink なら reject する utf8 上書き write (#418)。`readFileUtf8NoFollow` の
 * write 版で、user-IPC の `fs:write` が使う。
 *
 * **`fsp.writeFile(path, content, "utf8")` と等価**（access mode / 既定 mode 0o666 / syscall 列とも
 * 同じ）で、違いは末端が symlink のとき ELOOP で拒否する点だけ。既存 file は同一 inode のまま
 * truncate して書くので、tmp + rename の atomic write に倒れていない（inode 安定性を要求する
 * 呼び手の契約は fs.ts の #100 コメントを参照）。
 */
export async function writeFileUtf8NoFollow(path: string, content: string): Promise<void> {
	const fh = await fsp.open(path, NOFOLLOW_OVERWRITE_FLAGS);
	try {
		await fh.writeFile(content, "utf8");
	} finally {
		await fh.close();
	}
}

/**
 * 末端 component を follow せずに書く **atomic** write (#455)。inode 置換を伴うので、
 * `writeFileUtf8NoFollow` (同一 inode 上書き) とは契約が違う。pdf:export のように
 * 「上書きが途中で失敗しても旧 file を壊さない」ことが要る呼び手が使う。
 *
 * **`write-file-atomic` を使えない理由**: 同 package は書き込み先を自前で realpath 解決
 * (`realpath(filename).catch(() => filename)`) してから tmp + rename するため、認可 (T1) 後に
 * 末端を symlink へ swap されると **解決先 (workspace 外) へ書けてしまう**。realpath 解決を
 * 無効化する option は無い (v8.0.0 の option は mode / chown / fsync / tmpfileCreated /
 * encoding のみ)。実 node の probe で escape の成立も確認済み。
 *
 * **なぜ safe か**: `rename(2)` は **destination の末端 symlink を follow せず、symlink 自身を
 * 置き換える** (probe 実測: 外部を指す symlink へ rename すると解決先の内容は無傷のまま、
 * destination が通常 file になる)。したがって「認可した dir 配下に着地する」ことが
 * syscall の semantics として保証され、`O_NOFOLLOW` のような追加の検査は要らない。
 *
 * **末端 symlink を ELOOP で拒否しない**点が `writeFileUtf8NoFollow` との差になるが、
 * 経路の意味論は割れない: 呼び手が渡す canonical は認可時に realpath 済みで、ユーザーが
 * 張った正当な alias は **その時点で実体へ解決されている**。canonical の末端が symlink で
 * ありうるのは (a) 認可後の swap、(b) realpath cache の stale (#453)、(c) 認可時点で既に
 * dangling だった symlink (`realpathBestEffort` が祖先 fall-through して symlink 自身の path を
 * 返す) の 3 つで、いずれも symlink を置き換えるのは escape ではない (外部には届かない)。
 *
 * tmp は destination と同じ dir に作る (rename は同一 filesystem 内でしか原子的でないため)。
 * destination が既存の**通常 file** なら permission bit (`& 0o777`) を引き継ぐ。
 * `write-file-atomic` は mask せず setuid/setgid/sticky まで引き継ぐが、ここは落とす
 * (PDF 出力に特殊 bit を残す理由が無く、落とす方が安全側)。destination が symlink の場合は
 * **引き継がない**: `stat` は symlink を follow するので、swap 時に攻撃者が指した外部 file の
 * mode を着地 file に持ち込めてしまう。`lstat` + `isFile()` で判定する。
 *
 * **失った保証**: `write-file-atomic` の signal-exit hook が無いので、open 〜 rename の間 (ms
 * 単位) に SIGTERM / SIGINT で死ぬと tmp が出力先 dir に残る。名前は dot prefix なので
 * `showHidden` が既定 (false) の file tree には出ない。OS の file manager でも macOS Finder /
 * GNOME Files は dot file を既定で隠すので、既定設定で見えるのは Windows Explorer 等に限られる。
 */
export async function writeFileAtomicNoFollow(path: string, data: Buffer): Promise<void> {
	// dot prefix で既定の file tree から隠し、`.tmp` suffix と乱数で衝突を避ける。衝突しても
	// `O_EXCL` が EEXIST で落とすので、既存 entry を掴んで壊すことはない。
	const tmpPath = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
	// destination が既存の通常 file なら permission を引き継ぐ。symlink / dir / 未存在なら
	// 引き継がず、既定 mode (0o666 & ~umask) にする (doc の「mode 継承」節を参照)。
	const inheritedMode = await fsp.lstat(path).then(
		(st) => (st.isFile() ? st.mode & 0o777 : null),
		() => null,
	);
	// **open 時点で** 継承 mode を渡す。書いてから chmod で狭めると、内容入りの tmp が一瞬
	// 広い mode で存在する窓ができる (0o600 の file を置き換えるケース)。open の mode は
	// umask で削られるだけなので、広げ直しは書き込み後の chmod が担う。
	const fh = await fsp.open(tmpPath, NOFOLLOW_CREATE_EXCLUSIVE_FLAGS, inheritedMode ?? 0o666);
	// open が成功した = tmp は自分が作ったものなので、以降の失敗では消してよい。EEXIST 等で
	// open 自体が落ちた場合はここに来ないため、他者の entry を巻き込むことはない。
	try {
		try {
			await fh.writeFile(data);
			// umask に削られた bit を戻す。
			if (inheritedMode !== null) await fh.chmod(inheritedMode);
			// rename 前に data を disk へ落とす。ここを抜くと「rename は済んだが中身が
			// 空」という電源断時の壊れ方が残り、atomic write の意味が薄れる。
			await fh.sync();
		} finally {
			await fh.close();
		}
		await fsp.rename(tmpPath, path);
	} catch (e) {
		// rename まで到達しなかった場合に tmp を残さない。rename は try の最後の文なので、
		// 成功後にこの catch へ入る経路は無い (tmp も rename で消えている)。
		await fsp.rm(tmpPath, { force: true }).catch(() => {});
		throw e;
	}
}
