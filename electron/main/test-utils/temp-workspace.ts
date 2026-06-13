// テスト fixture: tmpdir 配下に一時ワークスペースを作成する。
// `electron/main` 配下の各 IPC ハンドラ test で散在していた
// `mkdtemp(join(tmpdir(), "scripta-xxx-"))` + `rm(...)` のパターンを集約する。
//
// path-guard が canonical（realpath 済み）パスで比較するため、macOS の
// `/var → /private/var` alias を踏むテストでは正規化版が必要。利用側の既存挙動に
// 合わせて `createTempWorkspace`（正規化なし）/ `createCanonicalTempWorkspace`
// （realpath で正規化）を使い分ける。
import { realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_PREFIX = "scripta-test-";

/**
 * tmpdir 配下に mkdtemp で作った dir を realpath で正規化して返す low-level helper。
 * git.test.ts のように cleanup を独自集約（`dirsToCleanup` 配列 + `maxRetries` 付き rm）
 * しているケース向け。
 */
export async function makeCanonicalTempDir(prefix: string = DEFAULT_PREFIX): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export interface TempWorkspace {
	dir: string;
	cleanup: () => Promise<void>;
}

export async function createTempWorkspace(prefix: string = DEFAULT_PREFIX): Promise<TempWorkspace> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	return {
		dir,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

export async function createCanonicalTempWorkspace(
	prefix: string = DEFAULT_PREFIX,
): Promise<TempWorkspace> {
	const dir = await makeCanonicalTempDir(prefix);
	return {
		dir,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

export interface SymlinkedWorkspace {
	/** mkdtemp で作った実ディレクトリ。 */
	realDir: string;
	/** realDir を realpath で正規化したパス（chokidar 等が emit する canonical 表記）。 */
	canonicalRealDir: string;
	/** tmpdir 直下に張った symlink。`symlinkDir -> realDir`。 */
	symlinkDir: string;
	cleanup: () => Promise<void>;
}

/**
 * 「symlink 経由でアクセスされる workspace」用の fixture。
 * watcher.integration.test.ts のように、tmpdir 直下に張った symlink を
 * workspace root として登録し、chokidar が canonical 配下のパスを emit する状況を
 * 再現する用途。
 *
 * cleanup の `unlinkSync` は best-effort（先に消えていても realDir の rm に進む）。
 */
export async function createSymlinkedWorkspace(
	realPrefix = "scripta-real-",
	symlinkPrefix = "scripta-symlink",
): Promise<SymlinkedWorkspace> {
	const realDir = await mkdtemp(join(tmpdir(), realPrefix));
	const canonicalRealDir = realpathSync(realDir);
	const symlinkDir = join(tmpdir(), `${symlinkPrefix}-${process.pid}-${Date.now()}`);
	symlinkSync(realDir, symlinkDir);
	return {
		realDir,
		canonicalRealDir,
		symlinkDir,
		async cleanup() {
			try {
				unlinkSync(symlinkDir);
			} catch {
				// best-effort
			}
			await rm(realDir, { recursive: true, force: true });
		},
	};
}
