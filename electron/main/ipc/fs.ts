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
	invalidateRealpathCacheEntry,
} from "../utils/path-guard";
import { StructuredError } from "../utils/structured-error";
import { getFileTreeFilterOptions } from "./settings";

// fs:read のサイズ上限。`.md` は通常 1MB 未満なので 64MB は十分なマージン。
// 巨大ファイル（動画 / バイナリ等）をワークスペースに置かれた場合の OOM を防ぐ。
// 他 handler の上限（OGP body 100KB / git conflict 10MB / GitHub release 100KB）と
// 同じ「明示的な上限を持つ」思想で揃える。
export const MAX_READ_FILE_BYTES = 64 * 1024 * 1024;

async function pathExistsAt(absolute: string): Promise<boolean> {
	try {
		await fsp.access(absolute);
		return true;
	} catch (e) {
		// ENOENT 以外（EACCES, EPERM 等）を握りつぶすと、rename/delete のような
		// 呼び出し元が「実際は権限問題なのに Source not found / Not found」と
		// 誤分類してしまう。ENOENT のみ false 扱いにし、他は呼び出し側に伝播する。
		if (isErrnoCode(e, "ENOENT")) return false;
		throw e;
	}
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
// canonical の末端が symlink であり得るのは 2 通り:
//   1. `realpathBestEffort` が祖先 fall-through した（= dangling symlink）。read open は解決先が
//      無いので `O_NOFOLLOW` の有無に関わらず失敗する（ELOOP / ENOENT）が、**O_CREAT を含む
//      write open は成功して解決先を新規作成してしまう**（次段落の escape がこれ）
//   2. `realpathCache` が stale で、cache に載った後に実体が symlink へ置き換わった。ここは
//      正当な alias 化（ユーザーの操作）と swap 攻撃の両方を含むので、ELOOP を受けた側で
//      cache を捨てて再認可し、fresh な realpath で切り分ける（`withStaleCacheRetry`）
// cache が fresh な限り workspace 内の正当な symlink note は realpath が実体まで解決するので、
// canonical は非 symlink になり flag は発火しない。
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
//   - `fs:rename`: `rename(2)` は末端 symlink を辿らず link 自体を張り替える。source 側が
//     dangling symlink の場合はそもそも `pathExistsAt`（access は follow する）が false を
//     返して Source not found で止まる
//
// **末端 swap 窓が残る経路（受容）**: 以下は path を再 traversal する API を使うため、認可後に
// 末端を symlink へ差し替えられると解決先を見に行く。閉じるには fd 相対 traversal が要るが
// Node は `readdir`/`stat` の fd 版を expose していない。露出するのは **entry 名と存在の有無**
// だけで内容には届かないため受容する:
//   - `fs:list`: `readdir` は末端が dir への symlink なら解決先を列挙する
//   - `fs:path-exists` / `fs:file-exists`: `access` / `stat` は末端 symlink を辿るため、
//     workspace 外 path の存在オラクルになり得る
//
// **`fs:delete` は「解決先を消す」**: canonical は realpath 済みなので、cache が fresh な限り、
// workspace 内の live な alias を削除すると `shell.trashItem` に渡るのは alias ではなく**実体**の
// path になる。境界は破らない（実体も root 内）が、直感には反する。cache が stale なら逆に alias
// 自身が trash へ行く（delete は ELOOP を出さないので `withStaleCacheRetry` の自己修復も働かない）。source が dangling symlink なら rename と
// 同じ理由で Not found になり削除できない（UX 側の帰結は #454）。

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

// 「認可 → O_NOFOLLOW I/O、ELOOP なら realpath cache を捨てて 1 度だけ再認可」の骨格 (#418)。
//
// ELOOP は **2 つの状態を区別せずに**知らせる:
//   (a) `realpathCache` が stale で、canonical が今は workspace 内の symlink になっている。
//       ユーザーが session 中に file を alias 化した（git checkout / 同期クライアント等）ケースで、
//       **正当な操作**。cache が cold なら realpath が実体まで解決するので、成否が cache の温度で
//       変わってしまう
//   (b) 認可後に末端を symlink へ swap された。**拒否すべき**ケース
// cache entry を落として認可し直すと、fresh な realpath が両者を分ける: (a) は実体へ解決して通り、
// (b) は解決先が workspace 外なら PATH_OUTSIDE_WORKSPACE で落ちる。判定材料が realpath 1 回に
// 揃うので、検索側 (ADR-0011 の「解決し直して in-root なら解決先を読む」) とも挙動が一致する。
//
// **再試行は 1 度だけ**。dangling symlink のように fresh な realpath でも解決できない path は
// 祖先 fall-through で同じ canonical に戻るため、2 度目の ELOOP をそのまま呼び手へ伝播させる。
// 正常系ではこの経路自体に入らないので、hot path に追加コストは乗らない。
async function withStaleCacheRetry<T>(
	senderId: number,
	path: string,
	assertAllowed: (windowId: number, p: string) => Promise<string>,
	io: (canonical: string) => Promise<T>,
): Promise<T> {
	try {
		return await io(await assertAllowed(senderId, path));
	} catch (e) {
		if (!isErrnoCode(e, "ELOOP")) throw e;
		invalidateRealpathCacheEntry(path);
		return await io(await assertAllowed(senderId, path));
	}
}

async function readFileImpl(senderId: number, path: string): Promise<string> {
	return withStaleCacheRetry(senderId, path, assertPathAllowed, async (canonical) => {
		// 1 回の open で stat と read を済ませて syscall を半減（fs:read は editor の hot path）。
		// read だけ helper ではなく flag を借りているのは、bounded read が fd 自体を要するため。
		const fh = await fsp.open(canonical, NOFOLLOW_READ_FLAGS);
		try {
			return await readFileBoundedFromHandle(fh, canonical, MAX_READ_FILE_BYTES);
		} finally {
			await fh.close();
		}
	});
}

// exportAsHtml の data URI 埋め込み用に、workspace 内の画像を base64 で読む (#314)。
// - path-guard で workspace 外 read を拒否する (fs:read と同じ保証)
// - 拡張子を image ホワイトリストで絞る (mimeForImageExt が null → reject)。
//   任意の binary を base64 で吸い上げられる能力を封じ、能力最小化する
// - サイズ上限は fs:read と共通 (64MB)。巨大画像は data URI 化しても外部ブラウザで
//   持たない (HTML file 自体が肥大化) ため、fail-loud で拒否するのが正解
async function readFileBase64Impl(senderId: number, path: string): Promise<string> {
	return withStaleCacheRetry(senderId, path, assertPathAllowed, async (canonical) => {
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
	});
}

async function writeFileImpl(senderId: number, path: string, content: string): Promise<void> {
	await withStaleCacheRetry(senderId, path, assertWritePathAllowed, async (canonical) => {
		await fsp.mkdir(dirname(canonical), { recursive: true });
		// **意図的に直接書き込み**。tmp + rename の atomic write は user workspace の
		// .md ファイルには使わない。理由（VS Code microsoft/vscode#195539 と同方針）:
		//   - inode が置き換わると symlink / hardlink が切れる
		//   - macOS の任意 xattr（Finder タグ、独自 metadata）と ACL が失われる
		//   - 外部 file watcher / Dropbox / iCloud / Git working tree の inode 安定性が崩れる
		// 引き換えに ENOSPC / SIGKILL 中の partial write リスクは残るが、user 編集中
		// ファイルでは metadata 保存と inode 安定性のほうが優先（#100 で wontfix 判断）。
		// app 内部 data (settings.ts / pdf.ts) は inode 安定性が問題にならないため、
		// そちらは引き続き write-file-atomic を使用している。
		//
		// `fsp.writeFile` ではなく `writeFileUtf8NoFollow` を使うのは #418 の escape 封鎖（上の
		// doc ブロック参照）。同一 inode 上書きという性質は変わらない。
		await writeFileUtf8NoFollow(canonical, content);
		// 書き込み成功後にだけ transient capability を消費する。
		// 失敗時は残り、renderer 側 withRetry で再試行できる。
		consumeTransientWritePath(senderId, canonical);
	});
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
	if (!(await pathExistsAt(oldCanonical))) throw FsError.sourceNotFound(oldCanonical);
	// fs.rename は target 既存時に上書きする default 挙動なので、
	// 「Target already exists」を出すために事前 check が必要。
	// 単一ユーザーの mem アプリのためレースは許容。
	if (await pathExistsAt(newCanonical)) throw FsError.targetAlreadyExists(newCanonical);
	await fsp.mkdir(dirname(newCanonical), { recursive: true });
	await fsp.rename(oldCanonical, newCanonical);
}

async function deleteEntryImpl(senderId: number, path: string): Promise<void> {
	const canonical = await assertPathAllowed(senderId, path);
	if (!(await pathExistsAt(canonical))) throw FsError.notFound(canonical);
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
