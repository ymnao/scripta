import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StructuredError } from "./structured-error";

// fs IPC のガードは window-scoped。allowedRoots は Map<windowId, Set<string>>
// 構造を取り、ある window が `workspace:set` で申告して登録した root だけがその
// window からの fs IPC で許可される（read/list/rename/delete/write 全て同じ Set）。
//
// 信頼境界: approve リスト（workspace.ts の `approvedWorkspacePaths`）も
// window-scoped（Map<windowId, Set<string>>）。window A で picker 承認した path は
// window B の workspace:set では受け付けない。saved workspacePath は createWindow で
// 当該 window に対して approve される。
//
// 保証する 2 点:
//   1. approve 済みでない任意 path に対する権限昇格を防ぐ（main 側で reject）
//   2. ある window が register していない root には fs IPC が通らない
const windowAllowedRoots = new Map<number, Set<string>>();

// dialog.showSaveDialog でユーザーが明示選択した保存先など、ワークスペース外でも
// 「ユーザーの意図的な書き込み」として 1 回限り許可するパス。
// 設計上の重要点：
//   1. window 単位（webContents.id）でスコープ。別ウィンドウから消費できない
//   2. read/list/rename/delete 等の非書き込み IPC では参照しない（write 専用 capability）
//   3. consume（削除）は assertWritePathAllowed の時点ではなく書き込み成功後。
//      これで withRetry の再試行（EBUSY/EAGAIN 等）が transient を temporarily 失わない
//   4. window close 時に該当 window の transient を全削除して cleanup
const transientWritePaths = new Map<number, Set<string>>();

export function validatePath(p: string): string {
	if (typeof p !== "string" || p.length === 0) {
		throw new StructuredError("INVALID_PATH", "Invalid path: empty");
	}
	if (p.includes("\0")) {
		throw new StructuredError("INVALID_PATH", "Invalid path: null byte");
	}
	if (!isAbsolute(p)) {
		throw new StructuredError("INVALID_PATH", "Invalid path: must be absolute");
	}
	return resolve(p);
}

// 対象が未存在でも、最も近い実在する祖先を realpath して、その下に suffix を付与した
// パスを返す。これにより:
//  - macOS の /var → /private/var など、root と対象の symlink 解決状態が一致する
//  - 中間ディレクトリが symlink の場合も正しく解決される（symlink-in-the-middle 対策）
// すべての祖先が解決失敗した場合は入力をそのまま返す（fall-through）。
//
// 実在する祖先の realpath 結果を簡易 LRU でキャッシュする。Symlink target の
// 変更は process 寿命中に発生する稀有なケースで、Electron app の典型的な
// 使用シナリオでは許容範囲内と判断。
//
// **用途境界 (#406)**: この cache は user-IPC 認可 (assertPathAllowed /
// assertWritePathAllowed / isPathAllowed / isPathWithinAnyAllowedRoot) 専用。
// L3 index 取り込みゲート (resolveInsideRoot) は cache を通さない —
// symlink retarget を watcher batch 由来の invalidation で確実に拾えないため、
// 取り込み時点の fresh な realpath が必要（詳細は resolveInsideRoot の doc）。
const realpathCache = new Map<string, string>();
const REALPATH_CACHE_MAX = 256;

async function cachedRealpath(p: string): Promise<string> {
	const cached = realpathCache.get(p);
	if (cached !== undefined) {
		// LRU: 末尾に move（Map は insertion order を保つ）
		realpathCache.delete(p);
		realpathCache.set(p, cached);
		return cached;
	}
	const result = await realpath(p);
	if (realpathCache.size >= REALPATH_CACHE_MAX) {
		const oldest = realpathCache.keys().next().value;
		if (oldest !== undefined) realpathCache.delete(oldest);
	}
	realpathCache.set(p, result);
	return result;
}

async function realpathBestEffort(p: string): Promise<string> {
	let current = p;
	let suffix = "";
	while (true) {
		try {
			const real = await cachedRealpath(current);
			return suffix ? join(real, suffix) : real;
		} catch {
			const parent = dirname(current);
			if (parent === current) return p;
			suffix = suffix ? join(basename(current), suffix) : basename(current);
			current = parent;
		}
	}
}

// validatePath + realpath 正規化済みのパスを返す。workspace.ts のように
// 「path-guard と整合した正規形」で値を保持したい呼び出し側用の helper。
export async function canonicalize(p: string): Promise<string> {
	return realpathBestEffort(validatePath(p));
}

export async function registerWorkspaceRoot(windowId: number, p: string): Promise<void> {
	const canonical = await canonicalize(p);
	let set = windowAllowedRoots.get(windowId);
	if (set === undefined) {
		set = new Set<string>();
		windowAllowedRoots.set(windowId, set);
	}
	set.add(canonical);
}

export async function unregisterWorkspaceRoot(windowId: number, p: string): Promise<void> {
	const canonical = await canonicalize(p);
	const set = windowAllowedRoots.get(windowId);
	if (set === undefined) return;
	set.delete(canonical);
	if (set.size === 0) windowAllowedRoots.delete(windowId);
}

// 該当ウィンドウが close したときの cleanup。allowedRoots と transientWritePaths を
// まとめて消すことで、後続のゾンビ window-id 経由でガードが緩む事故を防ぐ。
export function clearWorkspaceRootsForWindow(windowId: number): void {
	windowAllowedRoots.delete(windowId);
	transientWritePaths.delete(windowId);
}

// realpathCache から `p` 自身の entry を落とす (#418)。
//
// 用途は 1 つだけ: 認可済み canonical への `O_NOFOLLOW` open が ELOOP を返した呼び手が、
// 「cache が stale だっただけ」と「認可後に末端を swap された」を切り分けるために使う。
// 落としたうえで assert 系を呼び直すと、fresh な realpath で両者が分かれる（fs.ts の
// `withStaleCacheRetry` を参照）。
//
// 祖先 entry は触らない: ELOOP が知らせるのは末端 component の状態だけで、祖先を無効化する根拠が
// 無いため（祖先が stale でないことの保証ではない）。祖先が stale なまま fall-through した場合は
// 再認可後も同じ末端に戻り、2 度目の ELOOP が伝播して fail-closed になる。cache 全体の鮮度問題
// そのものは #453 で追跡している。
export function invalidateRealpathCacheEntry(p: string): void {
	if (typeof p !== "string" || p.length === 0) return;
	realpathCache.delete(resolve(p));
}

export function clearWorkspaceRoots(): void {
	windowAllowedRoots.clear();
	transientWritePaths.clear();
	// テスト間で symlink ターゲットを切り替えるケースに備え、realpath cache も clear する
	realpathCache.clear();
}

export function getWorkspaceRootsForWindow(windowId: number): string[] {
	const set = windowAllowedRoots.get(windowId);
	return set ? [...set] : [];
}

// 該当 window が登録している workspace root のうち canonical を含むものを返す。
// 複数 root が canonical を含む場合（nested workspace 等）は **最長一致** = 最も具体的な
// root を返す。FileTree フィルタの root-anchored パターン（`/foo`, `build/output` 等）の
// 評価がズレないようにするため。見つからなければ null。fs IPC のフィルタアンカーとして使う:
// `assertPathAllowed` 成功直後に呼べば、その path を含む root が必ず存在する。
export function findContainingWorkspaceRoot(windowId: number, canonical: string): string | null {
	const set = windowAllowedRoots.get(windowId);
	if (set === undefined) return null;
	let best: string | null = null;
	for (const root of set) {
		if (!isPathInside(canonical, root)) continue;
		if (best === null || root.length > best.length) best = root;
	}
	return best;
}

export async function registerTransientWritePath(windowId: number, p: string): Promise<void> {
	const canonical = await canonicalize(p);
	let set = transientWritePaths.get(windowId);
	if (set === undefined) {
		set = new Set<string>();
		transientWritePaths.set(windowId, set);
	}
	set.add(canonical);
}

// この関数は **canonical 前提** API。`assertWritePathAllowed` の戻り値や
// `canonicalize()` の結果をそのまま渡すこと。raw（未正規化）パスを渡しても
// silently false を返して capability が解放されない可能性がある。
//
// fs:write / fs:write-new は成功時に毎回これを呼ぶため、transient 未登録の
// 通常保存（workspace 内 write）が hot path。
//   1. 該当 window の Set が無ければ即 false（realpath を走らせない）
//   2. ある場合も「canonical 前提」なので追加の realpath 呼び出しは不要
// により hot path で realpath syscall を回避する。
export function consumeTransientWritePath(windowId: number, canonicalPath: string): boolean {
	const set = transientWritePaths.get(windowId);
	if (set === undefined) return false;
	const removed = set.delete(canonicalPath);
	if (set.size === 0) transientWritePaths.delete(windowId);
	return removed;
}

export function clearTransientWritePathsForWindow(windowId: number): void {
	transientWritePaths.delete(windowId);
}

export function getTransientWritePathsForWindow(windowId: number): string[] {
	const set = transientWritePaths.get(windowId);
	return set ? [...set] : [];
}

function isPathInside(child: string, parent: string): boolean {
	if (child === parent) return true;
	const rel = relative(parent, child);
	if (rel.length === 0) return false;
	if (isAbsolute(rel)) return false;
	// rel.startsWith("..") だけだと "..backup/foo" のようにディレクトリ名が ".." で
	// 始まる正当なパスを誤って outside 扱いにしてしまう。
	// 「親に上がる」のは rel === ".." または rel が `..${sep}` で始まる場合のみ。
	if (rel === "..") return false;
	if (rel.startsWith(`..${sep}`)) return false;
	return true;
}

function isWithinWindowAllowedRoot(windowId: number, target: string): boolean {
	return findContainingWorkspaceRoot(windowId, target) !== null;
}

// Fail-closed: ウィンドウ未登録時はすべて拒否する。
// renderer 側 AppLayout が settings から読み込んだ workspacePath を workspaceSet で
// 申告した時点で初めて register されるため、初回起動 / ワークスペース未選択時は
// fs:* IPC が一切通らないことが保証される。
//
// この関数は read/list/rename/delete などの非書き込み系で使う。
// SaveDialog 由来の transient write 許可は **参照しない**（write 専用 capability）。
//
// 戻り値: 許可された場合の **canonical（validatePath + realpathBestEffort 済み）**
// パス。呼び出し側は判定に使ったこの canonical を実 I/O にも使うべき：
//   - 判定（realpath 済み）と I/O（raw path）で別の path を使うと、TOCTOU で
//     チェック後に symlink が差し替わって workspace 外アクセスが成立しうる
//   - assert 内で realpath を 1 回だけ計算し、その結果を返すことで重複正規化も
//     避けられる（hot path の syscall 削減）
//
// **TOCTOU の限界 (#412 / #418)**: 戻り値が path である以上、呼び出し側の I/O は再度 traversal
// するため、認可 (T1) と I/O (T2) の間に構成要素を symlink へ差し替えられる窓が残る。窓は
// 末端 component と中間 dir の 2 つに分かれ、**末端側だけが閉じている**:
//   - **末端 component: 内容を返す / 書く経路では閉じた**。index 取り込み経路
//     (resolveInsideRoot) は #412 で、user-IPC の fs:read / fs:read-base64 / fs:write は #418 で
//     `O_NOFOLLOW` 付き fd の I/O に揃えた。**内容に届かない経路 (fs:list / fs:path-exists /
//     fs:file-exists) は窓が残る** (entry 名と存在の有無のみ露出。fd 版 readdir/stat が無いため
//     受容)。経路ごとの根拠は fs.ts 冒頭の doc ブロックを参照。**この doc が扱うのは fs IPC
//     だけ**で、同じ assert を使う他の write 経路 (pdf.ts の writeFileAtomic / git.ts の
//     resolveConflict) には同種の窓が残っている (追跡: #455)。
//   - **中間 dir: 受容**。閉じるには fd 相対 traversal (POSIX `openat` / Linux `openat2` の
//     `RESOLVE_BENEATH`) が要るが Node はどちらも expose していない (resolveInsideRoot の doc 参照)。
// **Windows では末端側も閉じない**: `O_NOFOLLOW` が無く flag が 0 に落ちるため plain open 相当に
// なる (#451 で追跡)。
// **realpathCache 由来の鮮度差**: 本 API は cache 済みの realpath 結果を使うため、symlink の
// retarget 直後は canonical が stale になり得る。stale な canonical は「cache 時点で root 内と
// 確認済みだった path」だが、その path 自身が今は symlink になっている可能性があり、**上の
// O_NOFOLLOW があって初めて**外部内容の read / 外部 file の上書きが防がれる (cache hit は
// swap 窓を再現可能にするので、fs.test.ts の #418 test はこの経路を fixture に使っている)。
// 残る劣化は「ユーザーから見た解決先とのズレ」で、これは #418 のスコープ外として受容し、
// 判断は #453 で追跡する。
//
// validatePath が throw する場合（相対パス・null byte 等）は kind=INVALID_PATH、
// ガード違反は kind=PATH_OUTSIDE_WORKSPACE の StructuredError を投げる。
// 呼び出し側 / renderer は getErrorKind で kind を復元し 2 種類を区別できる。
export async function assertPathAllowed(windowId: number, p: string): Promise<string> {
	const target = await realpathBestEffort(validatePath(p));
	if (isWithinWindowAllowedRoot(windowId, target)) return target;
	// 違反パスはレンダラに返さず、main 側ログにだけ残す（情報漏洩防止）
	console.warn(`[path-guard] denied outside workspace: ${p}`);
	throw new StructuredError("PATH_OUTSIDE_WORKSPACE", "Permission denied: outside workspace");
}

// write 系 IPC（fs:write / fs:write-new）専用ガード。
// 該当 window の workspace root マッチ OR 該当 window の transient set にマッチで許可。
// **consume はしない**（withRetry の再試行中も許可が残るように）。
// 書き込み成功後に consumeTransientWritePath を呼んで明示的に capability を使い切る。
//
// 戻り値: 許可された場合の canonical パス（assertPathAllowed と同じ理由で I/O 側も
// この canonical を使うこと。TOCTOU 防止 + 重複正規化回避）。
export async function assertWritePathAllowed(windowId: number, p: string): Promise<string> {
	const target = await realpathBestEffort(validatePath(p));
	if (isWithinWindowAllowedRoot(windowId, target)) return target;
	const set = transientWritePaths.get(windowId);
	if (set?.has(target)) return target;
	console.warn(`[path-guard] write denied outside workspace: ${p}`);
	throw new StructuredError("PATH_OUTSIDE_WORKSPACE", "Permission denied: outside workspace");
}

// 副作用なし boolean 判定。validatePath が throw する不正入力でも例外を飲んで
// false を返す（boolean 契約）。assertPathAllowed の throw 経路で「権限エラー」と
// 「不正入力エラー」を区別したい呼び出し側は assertPathAllowed を使う。
export async function isPathAllowed(windowId: number, p: string): Promise<boolean> {
	try {
		return isWithinWindowAllowedRoot(windowId, await realpathBestEffort(validatePath(p)));
	} catch {
		return false;
	}
}

// `ioPath` を realpath 解決し、canonical root の内側なら **解決済み path** を、
// 外側 / 解決不能なら null を返す。#394 Phase D で L3 InvertedIndex への
// piggyback / idle fill 直前に呼ばれ、workspace 内 symlink ファイルが
// 外部を指すケース (`evil.md -> /Users/x/.ssh/config`) を index 取り込み前で
// 落とすためのガード。
// - Window scope を持たない background 経路 (idle fill / piggyback) 用のため、
//   assertPathAllowed とは別 API になる (window-id を持たない)。
// - canonicalRoot は既に realpath 済みである前提 (collectMdFilesForWorkspace 通過後)。
// - **戻り値の path で readFile すること** (#406 Finding 2)。raw path を読むと
//   「検査対象 (T1 の realpath) と読み取り対象 (T2 の symlink target)」がズレ、
//   検査通過後に workspace 内へ swap back された symlink 経由で外部内容が index に
//   取り込まれる TOCTOU が成立する。assertPathAllowed が canonical を返して
//   「判定に使った path で I/O する」契約と同型。
// - **戻り値を path で渡す以上、read は再度 traversal する** ため resolve (T1) から read (T2)
//   の間に構成要素を symlink へ差し替えられる窓が残る (#412)。この窓は 2 つに分かれ、
//   **片方だけが閉じている**:
//   - **末端 component: 閉じた**。index 取り込みに繋がる read (piggyback / idle fill /
//     dark assert の再 index) は `readFileUtf8NoFollow` (O_NOFOLLOW 付き fd read) を使い、
//     open 時点で末端が symlink なら ELOOP で reject して「読み取り失敗 = skip」に倒す。
//     本 API が非 null かつ入力 path 一致を返した時点で末端は非 symlink と確認済みなので、
//     正常系では発火しない (発火 = 実際に swap が起きた瞬間)。
//   - **中間 dir: 受容**。閉じるには fd 相対 traversal (POSIX `openat` / Linux `openat2` の
//     `RESOLVE_BENEATH`) が要るが Node はどちらも expose していない。macOS の
//     `O_NOFOLLOW_ANY` は `fs.constants` に無く magic number 直書き + darwin 限定になるため
//     採らない (詳細と再検討条件は open-nofollow.ts の doc)。成立には workspace 書込権限と
//     精密なタイミングが要り、payoff は main process の in-memory bigram に限られる
//     (candidates は renderer に非露出)。
//   - **hard link 置換は「末端が閉じた」の範囲外**: 同一 filesystem 内で外部 file への
//     hard link を末端に置く変種は realpath が恒等に振る舞うため T1 のゲートを通り、
//     O_NOFOLLOW も symlink ではないので発火しない。これは TOCTOU ではなく T1 時点から
//     通る設計境界で (#416 Finding 2 が追跡)、payoff は中間 dir 窓と同じ in-memory bigram 限り。
//   assertPathAllowed も同じ中間 dir 窓を持つ (下記 doc 参照)。
// - **realpathCache を通さない** (#406 Finding 1)。symlink の retarget は watcher batch
//   由来の invalidation では確実に拾えない (chokidar は followSymlinks: false で、
//   retarget を change event として emit する保証がない) ため、index 取り込み時点で
//   毎回 fresh に解決する。呼び出しは `!isIndexedAndValid` の file に限られるため、
//   index が育った file では syscall は発生しない。ただし「恒久的に index に載らない file」
//   (admission cutoff 超過 / root 外を指す symlink / workspace 内 alias) は毎回 invalid のまま
//   なので、その分だけは検索ごとに syscall が乗る (件数が限定的なので受容している)。
//   内訳: piggyback (search.ts) で 1 回 + idle fill (index-fill.ts) の skipUntilEpochChange が
//   runFill ローカルで kick ごとに作り直されるため、kick 1 回につきさらに 1 回。
// - **index が disabled な workspace ではこのゲート自体が呼ばれない** (#413 Finding 1)。
//   disabled 時は indexedEpoch が clear されて全 file が「未 index」に見えるため、ゲートを
//   残すと全 file 分の syscall が検索ごとに乗ってしまう (indexFile は no-op なので無駄)。
// - realpathBestEffort と異なり **祖先 fall-through をしない**: 未存在 / dangling symlink は
//   realpath が throw して null になる (fail-closed)。index ゲートに「最も近い実在祖先」の
//   近似は不要で、非実在 file は後段 readFile も失敗するため取り込み挙動に差は出ない。
// - validatePath が throw する不正入力 (相対 path / null byte) も null を返す。
// - **本 API 単独では「認可済みの内容」までは保証しない**: 戻り値以外の path や別ソース
//   (cache 等) から取得した内容と組み合わせる場合、検査時点と内容取得時点がズレるため、
//   その時間差を許容できるかは呼び手が判断すること (search.ts の L2 hit 経路は明示的に受容)。
/**
 * `resolveInsideRoot` の戻り値が「index に取り込んでよい in-root 実体」を指すかの純関数 (#413)。
 *
 * 2 つの除外を 1 つの述語に畳む:
 *  - null: 解決失敗 / workspace 外 (#394 Phase D / #399 Finding 2 の境界)
 *  - 解決先 !== 入力 path: workspace 内 symlink (alias)。walk は canonical root から始まり
 *    symlink dir へ降りない (readdir({withFileTypes}) が symlink→dir を isDirectory=false で
 *    返す) ため、不一致は「末端 file 自身が symlink」を意味する。alias の index / L2 key は
 *    walk が返す symlink path 側に付く一方、watcher (followSymlinks: false) の modify は
 *    解決先の path でしか来ないため invalidate が波及せず、stale entry が valid のまま残る。
 *
 * 判定を誤って実体を alias 扱いしても帰結は「index / L2 に載せず毎回 read + scan」で、
 * 結果の正しさではなくコスト側にしか倒れない (fail-safe)。
 *
 * **戻り値は boolean で、type predicate (`resolved is string`) にはしない**: true 側は
 * 健全 (一致 ⟹ 非 null) だが、false 側は「null (workspace 外)」と「別 string (alias)」の
 * 2 状態を含むため、predicate にすると TS が else 分岐で `resolved` を `null` に誤 narrow
 * する。将来 else 側で null と alias を区別する分岐 (dark assert の drop 内訳分類など) を
 * 書いたときに、alias 分岐が型上 dead code になる事故を避ける。true 側で解決済み path が
 * 必要な呼び手は、一致が保証されているので入力 path (`ioPath`) をそのまま使えばよい。
 */
export function isIndexableResolution(resolved: string | null, ioPath: string): boolean {
	return resolved === ioPath;
}

export async function resolveInsideRoot(
	ioPath: string,
	canonicalRoot: string,
): Promise<string | null> {
	let target: string;
	try {
		target = await realpath(validatePath(ioPath));
	} catch {
		return null;
	}
	if (target === canonicalRoot || isPathInside(target, canonicalRoot)) return target;
	return null;
}

// 全 window の登録 root を union で評価する process-wide 版。リクエスト元 webContents を
// 特定できない経路（カスタムプロトコルハンドラ等）専用。approve は window-scoped 化済み
// だが、protocol.handle コールバックに webContentsId を紐づける仕組みがないため
// この関数は引き続き process-wide union のまま維持している。
export async function isPathWithinAnyAllowedRoot(p: string): Promise<boolean> {
	let target: string;
	try {
		target = await realpathBestEffort(validatePath(p));
	} catch {
		return false;
	}
	for (const set of windowAllowedRoots.values()) {
		for (const root of set) {
			if (isPathInside(target, root)) return true;
		}
	}
	return false;
}
