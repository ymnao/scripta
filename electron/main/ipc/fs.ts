import { promises as fsp } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { shell } from "electron";
import { mimeForImageExt } from "../../../src/types/image";
import type { FileEntry } from "../../../src/types/workspace";
import { createEntryFilter } from "../utils/entry-filter";
import { FsError, isErrnoCode } from "../utils/fs-errors";
import { handle } from "../utils/ipc-handle";
import { NOFOLLOW_READ_FLAGS, writeFileUtf8NoFollow } from "../utils/open-nofollow";
import {
	assertPathAllowed,
	assertWritePathAllowed,
	consumeTransientWritePath,
	findContainingWorkspaceRoot,
} from "../utils/path-guard";
import { StructuredError } from "../utils/structured-error";
import { getFileTreeFilterOptions } from "./settings";

// fs:read のサイズ上限。`.md` は通常 1MB 未満なので 64MB は十分なマージン。
// 巨大ファイル（動画 / バイナリ等）をワークスペースに置かれた場合の OOM を防ぐ。
// 他 handler の上限（OGP body 100KB / git conflict 10MB / GitHub release 100KB）と
// 同じ「明示的な上限を持つ」思想で揃える。
export const MAX_READ_FILE_BYTES = 64 * 1024 * 1024;

// 存在判定は probe に渡す syscall だけが違うので、ENOENT の扱いはここ 1 箇所で決める。
// ENOENT 以外（EACCES, EPERM 等）を握りつぶすと、rename/delete のような呼び出し元が
// 「実際は権限問題なのに Source not found / Not found」と誤分類してしまう。
// ENOENT のみ false 扱いにし、他は呼び出し側に伝播する。
async function existsBy(
	probe: (absolute: string) => Promise<unknown>,
	absolute: string,
): Promise<boolean> {
	try {
		await probe(absolute);
		return true;
	} catch (e) {
		if (isErrnoCode(e, "ENOENT")) return false;
		throw e;
	}
}

// 2 つの存在判定の違いは **末端 symlink を辿るかどうか**:
//   - `pathExistsAt`（access）= **解決先**が存在するか。「使えるファイルがそこにあるか」を
//     問う `fs:path-exists` 向け
//   - `entryExistsAt`（lstat）= **entry 自体**が存在するか。link 自身を操作する
//     `fs:delete`（trashItem）/ `fs:rename`（rename(2)）向け。判定と操作の follow 有無が
//     一致するので、realpath が解決できない symlink（dangling / 循環）でも「実在する entry」
//     として扱える (#454)
function pathExistsAt(absolute: string): Promise<boolean> {
	return existsBy(fsp.access, absolute);
}

function entryExistsAt(absolute: string): Promise<boolean> {
	return existsBy(fsp.lstat, absolute);
}

// すべての impl は path-guard の assert 系から **canonical（realpath 済み）** を
// 受け取り、I/O にもその canonical を使う。これで:
//   1. 判定と実 I/O が同一パスになるため TOCTOU で symlink を差し替えられても
//      workspace 外アクセスが成立しない
//   2. validate + realpath が impl 内で 1 回だけになり、二重正規化のオーバーヘッドが消える
//
// **末端 component の pin (#418)**: canonical を渡しても I/O 側 API は path を再 traversal
// するため、認可 (T1) と I/O (T2) の間に末端を symlink へ差し替えられる窓が残る。read
// (`fs:read` / `fs:read-base64`) と上書き write (`fs:write`) は `O_NOFOLLOW` 付きで open した
// fd に対して I/O し、この窓を閉じる（win32 は flag が 0 に落ちるため従来挙動、#451 で追跡）。
//
// **認可時点で** canonical の末端が symlink であり得るのは **`realpathBestEffort` が祖先
// fall-through した場合、すなわち realpath がその path を解決できなかったとき**（dangling / 循環
// など。probe 実測でどちらも canonical が symlink 自身の path になり O_NOFOLLOW open が ELOOP に
// なることを確認済み）。#453 で realpath cache を撤去し認可が毎回 fresh になったので、
// 「cache が stale で、載った後に実体が symlink へ置き換わった」は原因から外れた。
// dangling の read open は解決先が無いので `O_NOFOLLOW` の有無に関わらず失敗する（ELOOP /
// ENOENT）が、**O_CREAT を含む write open は成功して解決先を新規作成してしまう**（次段落の
// escape がこれ）。workspace 内の正当な symlink note は認可時の realpath が実体まで解決するので、
// canonical は非 symlink になり flag は発火しない。
//
// **ELOOP はそのまま呼び手へ伝播する（fail-closed）**。cache 撤去後の ELOOP の原因は
// 「realpath が解決できない symlink（dangling / 循環）」か「認可 (T1) から open (T2) の間に
// 実際に swap された真の race」で、前者は再試行しても変わらない。後者のうち解決先が workspace
// 内なら再認可 + 再 open で成功しうるが、窓は handler 1 実行内の await 1 回分（認可の realpath
// 完了から open まで）まで縮んでおり、専用の再試行機構を維持する頻度的な根拠が無いので
// fail-closed に倒す（#418 当時は cache stale 由来の**正当な alias 化**が
// 常時混ざっていたため、cache を捨てて 1 度だけ再認可する `withStaleCacheRetry` が要った）。
//
// **`fsp.writeFile` のままでは workspace 外へ escape する**: dangling symlink（workspace 外の
// **未存在** path を指す）は realpath が ENOENT で throw し、canonical が symlink 自身の path
// になる。この path は root 内なのでガードを通り、`fsp.writeFile` は symlink を辿って
// workspace 外に file を**新規作成**してしまう。`O_NOFOLLOW` はこれを ELOOP で拒否する。
//
// **末端 symlink を作らない / 辿らない経路**（O_NOFOLLOW を足す必要が無い）:
//   - `fs:write-new` / `fs:create-file`: `wx`（O_CREAT|O_EXCL）は末端が symlink なら
//     dangling でも EEXIST になり、解決先を作らない
//   - `fs:create-directory`: 対象自体は非 recursive な `mkdir` なので同様に EEXIST
//   - `fs:rename`: `rename(2)` は末端 symlink を辿らず link 自体を張り替える。source / target の
//     存在判定も `entryExistsAt`（lstat、no-follow）なので判定と操作の follow 有無が揃う。
//     source が symlink ならその link 自体が移動し、target に entry が実在すれば（解決先の
//     有無に関わらず）Target already exists で reject する。check 通過後のレース窓で target に
//     symlink が現れた場合も `rename(2)` は link 自体を置き換えるので escape しない（test で pin）
//
// **末端 swap 窓が残る経路（受容）**: 以下は path を再 traversal する API を使うため、認可後に
// 末端を symlink へ差し替えられると解決先を見に行く。閉じるには fd 相対 traversal が要るが
// Node は `readdir`/`stat` の fd 版を expose していない。露出するのは **entry 名と存在の有無**
// だけで内容には届かないため受容する:
//   - `fs:list`: `readdir` は末端が dir への symlink なら解決先を列挙する
//   - `fs:path-exists` / `fs:file-exists`: `access` / `stat` は末端 symlink を辿るため、
//     workspace 外 path の存在オラクルになり得る。この 2 つは「解決先が使えるか」を問う API
//     なので follow は意図した semantics（dangling に対して false を返すのも仕様）。entry 自体
//     の存在を要する delete / rename 側は `entryExistsAt`（lstat）を使う
//
// **`fs:delete` は「解決先を消す」**: canonical は realpath 済みなので、workspace 内の live な
// alias を削除すると `shell.trashItem` に渡るのは alias ではなく**実体**の path になる。境界は
// 破らない（実体も root 内）が、直感には反する。一方 **realpath が解決できない path**（dangling /
// 循環 symlink 等）は canonical が link 自身の path になるため、`shell.trashItem` に渡るのは
// link 自体になる。存在判定を `entryExistsAt`（lstat）にしたことでここまで到達できる (#454)。
// `shell.trashItem` 自体が dangling symlink を trash へ送れるかは OS 側の挙動で、unit test では
// モックしているため未検証。失敗しても StructuredError が renderer に伝わり fail-visible に止まる。

// bounded read 本体。FileHandle を引数で受けるので test では fake handle を注入できる。
// 二段防御で size 上限を強制する:
//   1. stat 申告サイズが limit 超なら即 reject（典型 case の OOM 回避 + 早期失敗）
//   2. 実 read は limit+1 byte まで「段階拡張する buffer」で読み続ける。stat 申告と
//      実 size が異なっても、実 size が limit 以下なら通常通り完了し、limit+1 byte
//      まで実際に読めた場合のみ「上限超」として reject する
// 段階拡張で stat 申告 + 1 を初期容量にし、不足したら 2 倍ずつ拡張する。typical case
// の memory overhead は最小（stat 申告 ≈ 実 size のため拡張は走らない）、外部書込で
// 実 size が膨らんでも誤検知せず正しく実 size で受け入れる / 拒否する。
async function readFileBoundedFromHandle(
	fh: fsp.FileHandle,
	canonical: string,
	limit: number,
): Promise<string> {
	const stat = await fh.stat();
	if (stat.size > limit) {
		throw FsError.tooLarge(canonical, stat.size, limit);
	}
	const hardCap = limit + 1;
	let buf = Buffer.alloc(Math.min(stat.size + 1, hardCap));
	let total = 0;
	while (total < hardCap) {
		if (total === buf.length) {
			// 段階拡張: 容量を 2 倍に（hardCap で頭打ち）。初回拡張前の buf は stat 申告 + 1。
			const grown = Buffer.alloc(Math.min(buf.length * 2, hardCap));
			buf.copy(grown);
			buf = grown;
		}
		const { bytesRead } = await fh.read(buf, total, buf.length - total);
		if (bytesRead === 0) break;
		total += bytesRead;
	}
	if (total > limit) {
		throw FsError.tooLarge(canonical, total, limit);
	}
	return buf.subarray(0, total).toString("utf8");
}

async function readFileImpl(senderId: number, path: string): Promise<string> {
	const canonical = await assertPathAllowed(senderId, path);
	// 1 回の open で stat と read を済ませて syscall を半減（fs:read は editor の hot path）。
	// read だけ helper ではなく flag を借りているのは、bounded read が fd 自体を要するため。
	const fh = await fsp.open(canonical, NOFOLLOW_READ_FLAGS);
	try {
		return await readFileBoundedFromHandle(fh, canonical, MAX_READ_FILE_BYTES);
	} finally {
		await fh.close();
	}
}

// exportAsHtml の data URI 埋め込み用に、workspace 内の画像を base64 で読む (#314)。
// - path-guard で workspace 外 read を拒否する (fs:read と同じ保証)
// - 拡張子を image ホワイトリストで絞る (mimeForImageExt が null → reject)。
//   任意の binary を base64 で吸い上げられる能力を封じ、能力最小化する
// - サイズ上限は fs:read と共通 (64MB)。巨大画像は data URI 化しても外部ブラウザで
//   持たない (HTML file 自体が肥大化) ため、fail-loud で拒否するのが正解
async function readFileBase64Impl(senderId: number, path: string): Promise<string> {
	const canonical = await assertPathAllowed(senderId, path);
	if (mimeForImageExt(extname(canonical)) === null) {
		throw new StructuredError(
			"INVALID_PATH",
			`readFileBase64: unsupported extension: ${extname(canonical) || "(none)"}`,
			{ path: canonical },
		);
	}
	const fh = await fsp.open(canonical, NOFOLLOW_READ_FLAGS);
	try {
		const stat = await fh.stat();
		if (stat.size > MAX_READ_FILE_BYTES) {
			throw FsError.tooLarge(canonical, stat.size, MAX_READ_FILE_BYTES);
		}
		const buf = Buffer.alloc(stat.size);
		let total = 0;
		while (total < stat.size) {
			const { bytesRead } = await fh.read(buf, total, stat.size - total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		return buf.subarray(0, total).toString("base64");
	} finally {
		await fh.close();
	}
}

async function writeFileImpl(senderId: number, path: string, content: string): Promise<void> {
	const canonical = await assertWritePathAllowed(senderId, path);
	await fsp.mkdir(dirname(canonical), { recursive: true });
	// **意図的に直接書き込み**。tmp + rename の atomic write は user workspace の
	// .md ファイルには使わない。理由（VS Code microsoft/vscode#195539 と同方針）:
	//   - inode が置き換わると symlink / hardlink が切れる
	//   - macOS の任意 xattr（Finder タグ、独自 metadata）と ACL が失われる
	//   - 外部 file watcher / Dropbox / iCloud / Git working tree の inode 安定性が崩れる
	// 引き換えに ENOSPC / SIGKILL 中の partial write リスクは残るが、user 編集中
	// ファイルでは metadata 保存と inode 安定性のほうが優先（#100 で wontfix 判断）。
	// user 編集ファイル以外は inode 安定性が問題にならないため atomic 側に倒している:
	// app 内部 data (settings.ts / window-state.ts) は write-file-atomic、pdf:export は
	// 認可済み path へ書くため自前の tmp + rename (#455、utils/open-nofollow.ts)。
	//
	// `fsp.writeFile` ではなく `writeFileUtf8NoFollow` を使うのは #418 の escape 封鎖（上の
	// doc ブロック参照）。同一 inode 上書きという性質は変わらない。
	await writeFileUtf8NoFollow(canonical, content);
	// 書き込み成功後にだけ transient capability を消費する。
	// 失敗時は残り、renderer 側 withRetry で再試行できる。
	consumeTransientWritePath(senderId, canonical);
}

async function writeNewFileImpl(senderId: number, path: string, content: string): Promise<void> {
	const canonical = await assertWritePathAllowed(senderId, path);
	await fsp.mkdir(dirname(canonical), { recursive: true });
	const fh = await fsp.open(canonical, "wx");
	try {
		await fh.writeFile(content, "utf8");
	} finally {
		await fh.close();
	}
	consumeTransientWritePath(senderId, canonical);
}

async function listDirectoryImpl(
	senderId: number,
	path: string,
	opts?: unknown,
): Promise<FileEntry[]> {
	const canonical = await assertPathAllowed(senderId, path);
	const entries = await fsp.readdir(canonical, { withFileTypes: true });
	// 戻り値の path は renderer が保持する workspacePath（raw 入力側）と表記を揃える。
	// canonical（symlink 解決後）を返してしまうと、macOS の /var → /private/var、
	// symlink workspace などで FileTree の `replacePrefix(workspacePath, ...)` /
	// `startsWith(workspacePath)` 等の前提が崩れる。
	// I/O は canonical で行う（TOCTOU 防止）一方、戻り値の path は input 表記に揃える。
	const inputResolved = resolve(path);
	// gitignore 仕様の `/build/`（root アンカー）等を正しく評価するため、フィルタには
	// listing 中の directory ではなく workspace root を渡す。opts は IPC 経由 renderer 由来
	// （null / 文字列 / 配列等が渡りうる）なので、plain object かを確認したうえで boolean
	// 比較で fail-closed に判定する。
	const applyFilter =
		typeof opts === "object" &&
		opts !== null &&
		!Array.isArray(opts) &&
		(opts as Record<string, unknown>).applyFileTreeFilter === true;
	const workspaceRoot = applyFilter ? findContainingWorkspaceRoot(senderId, canonical) : null;
	const filter =
		workspaceRoot !== null ? createEntryFilter(getFileTreeFilterOptions(), workspaceRoot) : null;
	return entries
		.filter((entry) => filter?.(join(canonical, entry.name), entry.isDirectory()) ?? true)
		.map((entry) => ({
			name: entry.name,
			path: join(inputResolved, entry.name),
			isDirectory: entry.isDirectory(),
		}));
}

async function createFileImpl(senderId: number, path: string): Promise<void> {
	const canonical = await assertPathAllowed(senderId, path);
	await fsp.mkdir(dirname(canonical), { recursive: true });
	try {
		const fh = await fsp.open(canonical, "wx");
		await fh.close();
	} catch (e) {
		if (isErrnoCode(e, "EEXIST")) throw FsError.alreadyExists(canonical);
		throw e;
	}
}

async function createDirectoryImpl(senderId: number, path: string): Promise<void> {
	const canonical = await assertPathAllowed(senderId, path);
	// 親は recursive で先に作る。対象自体は非 recursive にすることで
	// 「既存なら EEXIST」を atomic に得る（race-free）。
	await fsp.mkdir(dirname(canonical), { recursive: true });
	try {
		await fsp.mkdir(canonical);
	} catch (e) {
		if (isErrnoCode(e, "EEXIST")) throw FsError.alreadyExists(canonical);
		throw e;
	}
}

async function pathExistsImpl(senderId: number, path: string): Promise<boolean> {
	const canonical = await assertPathAllowed(senderId, path);
	return pathExistsAt(canonical);
}

async function fileExistsImpl(senderId: number, path: string): Promise<boolean> {
	const canonical = await assertPathAllowed(senderId, path);
	try {
		const stat = await fsp.stat(canonical);
		return stat.isFile();
	} catch (e) {
		if (isErrnoCode(e, "ENOENT")) return false;
		throw e;
	}
}

async function renameEntryImpl(senderId: number, oldPath: string, newPath: string): Promise<void> {
	const oldCanonical = await assertPathAllowed(senderId, oldPath);
	const newCanonical = await assertPathAllowed(senderId, newPath);
	if (!(await entryExistsAt(oldCanonical))) throw FsError.sourceNotFound(oldCanonical);
	// fs.rename は target 既存時に上書きする default 挙動なので、
	// 「Target already exists」を出すために事前 check が必要。
	// 単一ユーザーの mem アプリのためレースは許容。
	if (await entryExistsAt(newCanonical)) throw FsError.targetAlreadyExists(newCanonical);
	await fsp.mkdir(dirname(newCanonical), { recursive: true });
	await fsp.rename(oldCanonical, newCanonical);
}

async function deleteEntryImpl(senderId: number, path: string): Promise<void> {
	const canonical = await assertPathAllowed(senderId, path);
	if (!(await entryExistsAt(canonical))) throw FsError.notFound(canonical);
	await shell.trashItem(canonical);
}

export function registerFsIpc(): void {
	handle("fs:read", (event, path: string) => readFileImpl(event.sender.id, path));
	handle("fs:read-base64", (event, path: string) => readFileBase64Impl(event.sender.id, path));
	handle("fs:write", (event, path: string, content: string) =>
		writeFileImpl(event.sender.id, path, content),
	);
	handle("fs:write-new", (event, path: string, content: string) =>
		writeNewFileImpl(event.sender.id, path, content),
	);
	handle("fs:list", (event, path: string, opts?: unknown) =>
		listDirectoryImpl(event.sender.id, path, opts),
	);
	handle("fs:create-file", (event, path: string) => createFileImpl(event.sender.id, path));
	handle("fs:create-directory", (event, path: string) =>
		createDirectoryImpl(event.sender.id, path),
	);
	handle("fs:path-exists", (event, path: string) => pathExistsImpl(event.sender.id, path));
	handle("fs:file-exists", (event, path: string) => fileExistsImpl(event.sender.id, path));
	handle("fs:rename", (event, oldPath: string, newPath: string) =>
		renameEntryImpl(event.sender.id, oldPath, newPath),
	);
	handle("fs:delete", (event, path: string) => deleteEntryImpl(event.sender.id, path));
}

export const __testing = {
	existsBy,
	readFileImpl,
	readFileBase64Impl,
	readFileBoundedFromHandle,
	writeFileImpl,
	writeNewFileImpl,
	listDirectoryImpl,
	createFileImpl,
	createDirectoryImpl,
	pathExistsImpl,
	fileExistsImpl,
	renameEntryImpl,
	deleteEntryImpl,
};
