// テスト fixture: tmpdir 配下に一時ワークスペースを作成する。
// `electron/main` 配下の各 IPC ハンドラ test で散在していた
// `mkdtemp(join(tmpdir(), "scripta-xxx-"))` + `rm(...)` のパターンを集約する。
//
// path-guard が canonical（realpath 済み）パスで比較するため、macOS の
// `/var → /private/var` alias を踏むテストでは正規化版が必要。利用側の既存挙動に
// 合わせて `createTempWorkspace`（正規化なし）/ `createCanonicalTempWorkspace`
// （realpath で正規化）を使い分ける。
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_PREFIX = "scripta-test-";

/**
 * tmpdir 配下に一時ディレクトリを作って path だけ返す low-level helper。
 * cleanup を呼び出し側で集約管理したいケース（git.test.ts の `dirsToCleanup` 配列に
 * 全 dir を push して `maxRetries` 付き rm でまとめて消す等）で使う。
 */
export function makeTempDir(prefix: string = DEFAULT_PREFIX): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

/**
 * `makeTempDir` の realpath 正規化版。
 * path-guard が canonical で比較するテストで使う。
 */
export async function makeCanonicalTempDir(prefix: string = DEFAULT_PREFIX): Promise<string> {
	return realpath(await makeTempDir(prefix));
}

export interface TempWorkspace {
	dir: string;
	cleanup: () => Promise<void>;
}

export async function createTempWorkspace(prefix: string = DEFAULT_PREFIX): Promise<TempWorkspace> {
	const dir = await makeTempDir(prefix);
	return {
		dir,
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

export async function createCanonicalTempWorkspace(
	prefix: string = DEFAULT_PREFIX,
): Promise<TempWorkspace> {
	const raw = await makeTempDir(prefix);
	const dir = await realpath(raw);
	return {
		dir,
		cleanup: () => rm(raw, { recursive: true, force: true }),
	};
}
