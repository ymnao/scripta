// @vitest-environment node
import { mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempWorkspace, type TempWorkspace } from "../test-utils/temp-workspace";
import {
	assertPathAllowed,
	assertWritePathAllowed,
	canonicalize,
	clearTransientWritePathsForWindow,
	clearWorkspaceRoots,
	clearWorkspaceRootsForWindow,
	consumeTransientWritePath,
	findContainingWorkspaceRoot,
	getTransientWritePathsForWindow,
	getWorkspaceRootsForWindow,
	isPathAllowed,
	isPathWithinAnyAllowedRoot,
	registerTransientWritePath,
	registerWorkspaceRoot,
	resolveInsideRoot,
	unregisterWorkspaceRoot,
	validatePath,
} from "./path-guard";

const WIN_A = 1;
const WIN_B = 2;

let workspaceDir = "";
let outsideDir = "";
let wsWorkspace: TempWorkspace;
let wsOutside: TempWorkspace;

beforeEach(async () => {
	clearWorkspaceRoots();
	wsWorkspace = await createTempWorkspace("scripta-pg-ws-");
	wsOutside = await createTempWorkspace("scripta-pg-out-");
	workspaceDir = wsWorkspace.dir;
	outsideDir = wsOutside.dir;
});

afterEach(async () => {
	clearWorkspaceRoots();
	await wsWorkspace.cleanup();
	await wsOutside.cleanup();
});

// POSIX 固定パス（/tmp/foo など）を扱う describe。Windows では path.resolve の結果が
// "C:\\tmp\\foo" になり assertion が落ちるため skip。Windows 専用の検証は
// 必要になった段階で別 describe を追加する。
describe.skipIf(process.platform === "win32")("validatePath", () => {
	it("returns absolute paths after normalization", () => {
		expect(validatePath("/tmp/test.md")).toBe("/tmp/test.md");
	});

	it("normalizes parent-traversal segments", () => {
		expect(validatePath("/tmp/foo/../bar/test.md")).toBe("/tmp/bar/test.md");
	});

	it("normalizes redundant separators", () => {
		expect(validatePath("/tmp//foo/./bar")).toBe("/tmp/foo/bar");
	});

	it("rejects empty string", () => {
		expect(() => validatePath("")).toThrow(/Invalid path: empty/);
	});

	it("rejects relative paths", () => {
		expect(() => validatePath("relative/path.md")).toThrow(/Invalid path: must be absolute/);
	});

	it("rejects paths containing null bytes", () => {
		expect(() => validatePath("/tmp/\0evil")).toThrow(/Invalid path: null byte/);
	});
});

describe("workspace root registration (window-scoped)", () => {
	it("registers a realpath-resolved root under a window", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		const roots = getWorkspaceRootsForWindow(WIN_A);
		expect(roots).toHaveLength(1);
		// macOS では /var → /private/var など symlink が解消される
		expect(roots[0].endsWith(basename(workspaceDir))).toBe(true);
	});

	it("unregisters a root from a window", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		await unregisterWorkspaceRoot(WIN_A, workspaceDir);
		expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([]);
	});

	it("clears all roots across windows", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		await registerWorkspaceRoot(WIN_B, outsideDir);
		clearWorkspaceRoots();
		expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([]);
		expect(getWorkspaceRootsForWindow(WIN_B)).toEqual([]);
	});

	it("clearWorkspaceRootsForWindow removes only one window's roots", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		await registerWorkspaceRoot(WIN_B, outsideDir);
		clearWorkspaceRootsForWindow(WIN_A);
		expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([]);
		expect(getWorkspaceRootsForWindow(WIN_B)).toHaveLength(1);
	});

	// 「全祖先を realpath できない / どのドライブも認識できない」入力を作るのは
	// プラットフォーム依存。POSIX でのみ確実に fall-through 経路を踏ませられる
	// ため、Windows は skip。fall-through 自体の挙動は Windows でも変わらない
	// （`realpathBestEffort` の実装は OS 非依存）が、テストの assertion 側を
	// drive 付き path に揃えるのが煩雑。
	it.skipIf(process.platform === "win32")(
		"registers non-existent paths by falling back to resolve()",
		async () => {
			const phantom = "/this/path/does/not/exist";
			await registerWorkspaceRoot(WIN_A, phantom);
			expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([phantom]);
		},
	);
});

describe("isPathAllowed (window-scoped)", () => {
	it("denies everything when the window has no roots (fail-closed)", async () => {
		// アプリ起動直後 / ワークスペース未選択時に任意 path へのアクセスを許してしまう
		// 抜け穴を防ぐ
		expect(await isPathAllowed(WIN_A, "/anywhere/file")).toBe(false);
		expect(await isPathAllowed(WIN_A, "/etc/passwd")).toBe(false);
	});

	it("does NOT see roots registered to a different window", async () => {
		// ウィンドウ A の renderer が ウィンドウ B の workspace 配下を read/list/rename/
		// delete できてしまう回帰を防ぐ
		await registerWorkspaceRoot(WIN_B, workspaceDir);
		const file = join(workspaceDir, "f.md");
		expect(await isPathAllowed(WIN_A, file)).toBe(false);
		await expect(assertPathAllowed(WIN_A, file)).rejects.toThrow(/Permission denied/);
		// 当該 window は通る
		expect(await isPathAllowed(WIN_B, file)).toBe(true);
	});

	it("isPathAllowed returns false for invalid input (boolean contract)", async () => {
		// validatePath が throw する系のフォールバックは false に寄せる：
		// 呼び出し側は「許可されているか?」のクエリとして使うため、boolean 契約を保つ
		expect(await isPathAllowed(WIN_A, "relative/path")).toBe(false);
		expect(await isPathAllowed(WIN_A, "")).toBe(false);
		expect(await isPathAllowed(WIN_A, "/tmp/\0evil")).toBe(false);
	});

	it("assertPathAllowed propagates validate errors as 'Invalid path: ...'", async () => {
		// 呼び出し側で「不正入力」と「権限エラー」を区別できるように、
		// validate エラーは Invalid path として throw する
		await expect(assertPathAllowed(WIN_A, "relative/path")).rejects.toThrow(
			/Invalid path: must be absolute/,
		);
		await expect(assertPathAllowed(WIN_A, "")).rejects.toThrow(/Invalid path: empty/);
	});

	it("allows files inside the window's workspace", async () => {
		const file = join(workspaceDir, "f.md");
		await writeFile(file, "x", "utf8");
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		expect(await isPathAllowed(WIN_A, file)).toBe(true);
	});

	it("rejects files outside the workspace", async () => {
		const outsideFile = join(outsideDir, "secret");
		await writeFile(outsideFile, "x", "utf8");
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		expect(await isPathAllowed(WIN_A, outsideFile)).toBe(false);
	});

	// fs.symlink は Windows で Developer Mode 無効時に EPERM になる。skip して
	// macOS / Linux でのみ symlink 検証を行う。
	it.skipIf(process.platform === "win32")(
		"blocks symlink-based escape from the workspace",
		async () => {
			const link = join(workspaceDir, "escape");
			await symlink(outsideDir, link);
			const target = join(link, "secret");
			await writeFile(target, "leaked", "utf8");
			await registerWorkspaceRoot(WIN_A, workspaceDir);
			expect(await isPathAllowed(WIN_A, target)).toBe(false);
		},
	);

	it("allows paths inside the workspace even before the file exists", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		const newPath = join(workspaceDir, "subdir", "new.md");
		expect(await isPathAllowed(WIN_A, newPath)).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"blocks symlink-based escape via intermediate directories",
		async () => {
			const link = join(workspaceDir, "escape");
			await symlink(outsideDir, link);
			await registerWorkspaceRoot(WIN_A, workspaceDir);
			const evil = join(link, "new-file.md");
			expect(await isPathAllowed(WIN_A, evil)).toBe(false);
		},
	);

	it("allows paths inside any of multiple roots registered to the same window", async () => {
		const { dir: second, cleanup } = await createTempWorkspace("scripta-pg-ws2-");
		try {
			await registerWorkspaceRoot(WIN_A, workspaceDir);
			await registerWorkspaceRoot(WIN_A, second);
			expect(await isPathAllowed(WIN_A, join(workspaceDir, "a.md"))).toBe(true);
			expect(await isPathAllowed(WIN_A, join(second, "b.md"))).toBe(true);
			expect(await isPathAllowed(WIN_A, join(outsideDir, "c.md"))).toBe(false);
		} finally {
			await cleanup();
		}
	});

	it("does not falsely match sibling directories sharing a name prefix", async () => {
		const { dir: sibling, cleanup } = await createTempWorkspace("scripta-pg-ws-");
		try {
			await registerWorkspaceRoot(WIN_A, workspaceDir);
			expect(await isPathAllowed(WIN_A, join(sibling, "f.md"))).toBe(false);
		} finally {
			await cleanup();
		}
	});

	it("allows directory names that start with '..' (e.g. '..backup') as legitimate paths", async () => {
		// `..backup` は二つのドットで始まる正当なディレクトリ名。
		// rel.startsWith("..") だけで判定すると偽陽性（outside）になる回帰を防ぐ
		const dotDir = join(workspaceDir, "..backup");
		await mkdir(dotDir);
		try {
			const target = join(dotDir, "note.md");
			await writeFile(target, "x", "utf8");
			await registerWorkspaceRoot(WIN_A, workspaceDir);
			expect(await isPathAllowed(WIN_A, target)).toBe(true);
		} finally {
			await rm(dotDir, { recursive: true, force: true });
		}
	});
});

describe("isPathWithinAnyAllowedRoot (process-wide)", () => {
	it("returns false when no window has registered any root (fail-closed)", async () => {
		expect(await isPathWithinAnyAllowedRoot("/anywhere/file")).toBe(false);
	});

	it("returns true if any window has registered a root containing the path", async () => {
		const file = join(workspaceDir, "img.png");
		await writeFile(file, "x", "utf8");
		await registerWorkspaceRoot(WIN_B, workspaceDir);
		// scripta-asset:// プロトコルハンドラはどの window から発行されたかを区別できない
		// ため、union として B 登録の root を A からのリクエストでも見える形で OK にする
		expect(await isPathWithinAnyAllowedRoot(file)).toBe(true);
	});

	it("returns false for paths outside any registered root", async () => {
		const outsideFile = join(outsideDir, "leak.png");
		await writeFile(outsideFile, "x", "utf8");
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		expect(await isPathWithinAnyAllowedRoot(outsideFile)).toBe(false);
	});

	it("returns false for invalid input (boolean contract)", async () => {
		expect(await isPathWithinAnyAllowedRoot("relative/path")).toBe(false);
		expect(await isPathWithinAnyAllowedRoot("")).toBe(false);
		expect(await isPathWithinAnyAllowedRoot("/tmp/\0evil")).toBe(false);
	});

	// fs.symlink は Windows で Developer Mode 無効時に EPERM になるため skip
	it.skipIf(process.platform === "win32")(
		"blocks symlink-based escape from any registered workspace",
		async () => {
			const link = join(workspaceDir, "escape");
			await symlink(outsideDir, link);
			const target = join(link, "secret.png");
			await writeFile(target, "leaked", "utf8");
			await registerWorkspaceRoot(WIN_A, workspaceDir);
			expect(await isPathWithinAnyAllowedRoot(target)).toBe(false);
		},
	);
});

// L3 index 取り込みゲート (#394 Phase D / #406)。window scope を持たず、
// canonical root を直接受け取る background 経路用 API。
describe("resolveInsideRoot (index ingestion gate)", () => {
	it("returns the resolved path for a regular file inside the root", async () => {
		const root = await canonicalize(workspaceDir);
		const file = join(root, "note.md");
		await writeFile(file, "x", "utf8");
		expect(await resolveInsideRoot(file, root)).toBe(file);
	});

	it("returns null for a file outside the root", async () => {
		const root = await canonicalize(workspaceDir);
		const outsideFile = join(await canonicalize(outsideDir), "secret.md");
		await writeFile(outsideFile, "x", "utf8");
		expect(await resolveInsideRoot(outsideFile, root)).toBeNull();
	});

	// realpathBestEffort 系 API と異なり祖先 fall-through をしない (fail-closed)。
	it("returns null for a non-existent path (no ancestor fall-through)", async () => {
		const root = await canonicalize(workspaceDir);
		expect(await resolveInsideRoot(join(root, "missing.md"), root)).toBeNull();
	});

	it("returns null for invalid input", async () => {
		const root = await canonicalize(workspaceDir);
		expect(await resolveInsideRoot("relative/path.md", root)).toBeNull();
		expect(await resolveInsideRoot("", root)).toBeNull();
		expect(await resolveInsideRoot("/tmp/\0evil", root)).toBeNull();
	});

	it.skipIf(process.platform === "win32")(
		"resolves an in-root symlink to its target path",
		async () => {
			const root = await canonicalize(workspaceDir);
			const target = join(root, "real.md");
			await writeFile(target, "inside", "utf8");
			const link = join(root, "link.md");
			await symlink(target, link);
			// 戻り値は symlink 自身ではなく実体 → 呼び手はこの path で readFile する。
			expect(await resolveInsideRoot(link, root)).toBe(target);
		},
	);

	it.skipIf(process.platform === "win32")(
		"returns null for an in-root symlink pointing outside the root",
		async () => {
			const root = await canonicalize(workspaceDir);
			const outsideFile = join(await canonicalize(outsideDir), "id_rsa");
			await writeFile(outsideFile, "secret", "utf8");
			const link = join(root, "evil.md");
			await symlink(outsideFile, link);
			expect(await resolveInsideRoot(link, root)).toBeNull();
		},
	);

	// #406 Finding 1 の回帰テスト: realpath 結果を cache して判定すると 2 回目も stale な
	// 「root 内」判定を返してしまう (watcher batch はこの retarget を確実には emit しない)。
	// user-IPC 認可側の同じ性質は #453 で揃えた (下の describe を参照)。
	it.skipIf(process.platform === "win32")(
		"reflects a symlink retarget without any explicit invalidation",
		async () => {
			const root = await canonicalize(workspaceDir);
			const inside = join(root, "inside.md");
			await writeFile(inside, "inside", "utf8");
			const outsideFile = join(await canonicalize(outsideDir), "id_rsa");
			await writeFile(outsideFile, "secret", "utf8");
			const link = join(root, "evil.md");
			await symlink(inside, link);
			// 1 回目: root 内を指しているので許可され、判定が cache されうる。
			expect(await resolveInsideRoot(link, root)).toBe(inside);
			// attacker が `ln -sf` 相当で外へ付け替える。
			await unlink(link);
			await symlink(outsideFile, link);
			// 2 回目: cache を通していれば旧判定 (inside) が返る = 外部内容が index に入る。
			expect(await resolveInsideRoot(link, root)).toBeNull();
		},
	);
});

// #453: user-IPC 認可 (assertPathAllowed / assertWritePathAllowed / isPathAllowed /
// isPathWithinAnyAllowedRoot) も realpath cache を持たないことの pin。上の resolveInsideRoot 版と
// 対になる性質で、cache を再導入すると 2 回目の判定が 1 回目を引きずってこの describe が落ちる。
// 判定が「その path を過去に認可したか」に依存しないので、認可の結果は毎回 disk の現状と一致する。
describe.skipIf(process.platform === "win32")("認可の realpath 鮮度 (#453)", () => {
	it("assertPathAllowed は symlink retarget を明示 invalidation 無しで反映する", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		const root = await canonicalize(workspaceDir);
		const inside = join(root, "inside.md");
		await writeFile(inside, "inside", "utf8");
		const outsideFile = join(await canonicalize(outsideDir), "id_rsa");
		await writeFile(outsideFile, "secret", "utf8");
		const link = join(root, "note.md");
		await symlink(inside, link);
		// 1 回目: root 内を指しているので許可され、canonical は実体側になる。
		expect(await assertPathAllowed(WIN_A, link)).toBe(inside);

		await unlink(link);
		await symlink(outsideFile, link);

		// 2 回目: 旧判定を引きずらず、fresh な realpath が外部を検出して拒否する。
		await expect(assertPathAllowed(WIN_A, link)).rejects.toThrow(/outside workspace/);
	});

	it("外へ retarget した symlink を root 内へ戻すと再び許可される (双方向)", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		const root = await canonicalize(workspaceDir);
		const inside = join(root, "inside.md");
		await writeFile(inside, "inside", "utf8");
		const outsideFile = join(await canonicalize(outsideDir), "id_rsa");
		await writeFile(outsideFile, "secret", "utf8");
		const link = join(root, "note.md");

		// 拒否判定も持ち越さない: 外 → 内 の retarget も次の認可で反映される。
		await symlink(outsideFile, link);
		expect(await isPathAllowed(WIN_A, link)).toBe(false);
		await unlink(link);
		await symlink(inside, link);
		expect(await isPathAllowed(WIN_A, link)).toBe(true);
		expect(await assertPathAllowed(WIN_A, link)).toBe(inside);
	});

	it("assertWritePathAllowed も retarget を反映する", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		const root = await canonicalize(workspaceDir);
		const inside = join(root, "inside.md");
		await writeFile(inside, "inside", "utf8");
		const outsideFile = join(await canonicalize(outsideDir), "victim.md");
		await writeFile(outsideFile, "victim", "utf8");
		const link = join(root, "note.md");
		await symlink(inside, link);
		expect(await assertWritePathAllowed(WIN_A, link)).toBe(inside);

		await unlink(link);
		await symlink(outsideFile, link);

		await expect(assertWritePathAllowed(WIN_A, link)).rejects.toThrow(/outside workspace/);
	});

	// 他の 4 本は末端 component の鮮度しか押さえていない。realpathBestEffort は未存在 path で
	// 祖先を 1 段ずつ realpath して fall-through するため、**祖先の解決結果だけを cache する**
	// 部分的な再導入 (深い未存在 path の syscall 削減が動機になりやすい) は末端側の pin を
	// すり抜ける。この 1 本が中間 dir symlink の鮮度を押さえる。
	// 未存在 suffix を 2 段にしてあるのは、「深さ N 段以上の fall-through だけ cache する」型の
	// 再導入も同じ 1 本で落とすため (1 段だと直近親しか cache されない実装をすり抜ける)。
	it("未存在 path の祖先 (中間 dir symlink) の retarget も反映する", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		const root = await canonicalize(workspaceDir);
		const realSub = join(root, "sub");
		await mkdir(realSub);
		const subLink = join(root, "link-sub");
		await symlink(realSub, subLink);
		// 末端も中間 (draft/) も未存在なので、realpath は 2 段 fall-through して link-sub で解決する。
		const target = join(subLink, "draft", "new.md");
		expect(await assertWritePathAllowed(WIN_A, target)).toBe(join(realSub, "draft", "new.md"));

		// 中間 dir symlink を workspace 外へ付け替える。末端 component は触っていない。
		await unlink(subLink);
		await symlink(outsideDir, subLink);

		await expect(assertWritePathAllowed(WIN_A, target)).rejects.toThrow(/outside workspace/);
	});

	it("isPathWithinAnyAllowedRoot も retarget を反映する", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		const root = await canonicalize(workspaceDir);
		const inside = join(root, "inside.md");
		await writeFile(inside, "inside", "utf8");
		const outsideFile = join(await canonicalize(outsideDir), "hero.png");
		await writeFile(outsideFile, "png", "utf8");
		const link = join(root, "hero.png");
		await symlink(inside, link);
		expect(await isPathWithinAnyAllowedRoot(link)).toBe(true);

		await unlink(link);
		await symlink(outsideFile, link);

		expect(await isPathWithinAnyAllowedRoot(link)).toBe(false);
	});
});

describe("assertPathAllowed (window-scoped)", () => {
	it("does not throw inside the window's workspace", async () => {
		const file = join(workspaceDir, "f.md");
		await writeFile(file, "x", "utf8");
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		await expect(assertPathAllowed(WIN_A, file)).resolves.not.toThrow();
		await expect(assertPathAllowed(WIN_A, join(workspaceDir, "new.md"))).resolves.not.toThrow();
	});

	it("throws a generic Permission denied error WITHOUT leaking the path", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		const offendingPath = join(outsideDir, "secret");
		await expect(assertPathAllowed(WIN_A, offendingPath)).rejects.toThrow(
			/^Permission denied: outside workspace$/,
		);
		try {
			await assertPathAllowed(WIN_A, offendingPath);
		} catch (e) {
			expect((e as Error).message).not.toContain(offendingPath);
			expect((e as Error).message).not.toContain(outsideDir);
		}
	});

	it("logs the offending path to console.warn but not to the thrown Error", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			await expect(assertPathAllowed(WIN_A, join(outsideDir, "x"))).rejects.toThrow();
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0][0]).toContain("[path-guard]");
			expect(spy.mock.calls[0][0]).toContain(outsideDir);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("transient write paths (window-scoped, write-only capability)", () => {
	it("isPathAllowed (read guard) does NOT see transient paths", async () => {
		const target = join(outsideDir, "export.html");
		await registerTransientWritePath(WIN_A, target);
		// transient は write 専用 capability。read 系では参照されない
		expect(await isPathAllowed(WIN_A, target)).toBe(false);
		await expect(assertPathAllowed(WIN_A, target)).rejects.toThrow(/Permission denied/);
	});

	it("assertWritePathAllowed permits a transient path without consuming it", async () => {
		const target = join(outsideDir, "export.html");
		await registerTransientWritePath(WIN_A, target);
		expect(getTransientWritePathsForWindow(WIN_A)).toHaveLength(1);

		// withRetry の再試行を想定して同じ window から複数回チェック → 全て通る
		await expect(assertWritePathAllowed(WIN_A, target)).resolves.not.toThrow();
		await expect(assertWritePathAllowed(WIN_A, target)).resolves.not.toThrow();
		// チェックだけでは consume されない
		expect(getTransientWritePathsForWindow(WIN_A)).toHaveLength(1);
	});

	it("consumeTransientWritePath removes the path only after explicit consume", async () => {
		const target = join(outsideDir, "export.html");
		await registerTransientWritePath(WIN_A, target);
		// consumeTransientWritePath は canonical 前提 API なので、呼び出し側は
		// canonicalize() の結果を渡す（fs.ts は assertWritePathAllowed の戻り値を渡す）
		expect(consumeTransientWritePath(WIN_A, await canonicalize(target))).toBe(true);
		expect(getTransientWritePathsForWindow(WIN_A)).toEqual([]);
		expect(consumeTransientWritePath(WIN_A, await canonicalize(target))).toBe(false);
	});

	it("permits write via workspace root regardless of transient state", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		const wsFile = join(workspaceDir, "f.md");
		await expect(assertWritePathAllowed(WIN_A, wsFile)).resolves.not.toThrow();
	});

	it("isolates transient paths per window (no cross-window consumption)", async () => {
		const target = join(outsideDir, "export.html");
		await registerTransientWritePath(WIN_A, target);
		await expect(assertWritePathAllowed(WIN_B, target)).rejects.toThrow(/Permission denied/);
		expect(getTransientWritePathsForWindow(WIN_B)).toEqual([]);
		await expect(assertWritePathAllowed(WIN_A, target)).resolves.not.toThrow();
	});

	it("clearTransientWritePathsForWindow removes only that window's paths", async () => {
		await registerTransientWritePath(WIN_A, join(outsideDir, "a.html"));
		await registerTransientWritePath(WIN_B, join(outsideDir, "b.html"));
		clearTransientWritePathsForWindow(WIN_A);
		expect(getTransientWritePathsForWindow(WIN_A)).toEqual([]);
		expect(getTransientWritePathsForWindow(WIN_B)).toHaveLength(1);
	});

	it("clearWorkspaceRootsForWindow also wipes transient paths for that window", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		await registerTransientWritePath(WIN_A, join(outsideDir, "x.html"));
		clearWorkspaceRootsForWindow(WIN_A);
		expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([]);
		expect(getTransientWritePathsForWindow(WIN_A)).toEqual([]);
	});

	it("clearWorkspaceRoots also wipes transient paths for all windows (test reset)", async () => {
		await registerTransientWritePath(WIN_A, join(outsideDir, "a.html"));
		await registerTransientWritePath(WIN_B, join(outsideDir, "b.html"));
		clearWorkspaceRoots();
		expect(getTransientWritePathsForWindow(WIN_A)).toEqual([]);
		expect(getTransientWritePathsForWindow(WIN_B)).toEqual([]);
	});
});

describe.skipIf(process.platform === "win32")("findContainingWorkspaceRoot", () => {
	it("returns null when window has no registered roots", async () => {
		expect(findContainingWorkspaceRoot(WIN_A, join(workspaceDir, "x"))).toBeNull();
	});

	it("returns the root when a single root contains the target", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		const canonical = await canonicalize(join(workspaceDir, "sub", "x.md"));
		expect(findContainingWorkspaceRoot(WIN_A, canonical)).toBe(await canonicalize(workspaceDir));
	});

	it("returns the longest matching root when multiple roots contain the target (nested)", async () => {
		const nested = join(workspaceDir, "sub");
		await mkdir(nested);
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		await registerWorkspaceRoot(WIN_A, nested);
		const canonical = await canonicalize(join(nested, "x.md"));
		// 親 + 子両方が match するが、最長一致（nested 側）が anchor として返る
		expect(findContainingWorkspaceRoot(WIN_A, canonical)).toBe(await canonicalize(nested));
	});

	it("returns null when target is outside all registered roots", async () => {
		await registerWorkspaceRoot(WIN_A, workspaceDir);
		const outside = await canonicalize(join(outsideDir, "x.md"));
		expect(findContainingWorkspaceRoot(WIN_A, outside)).toBeNull();
	});

	it("is window-scoped (does not see other windows' roots)", async () => {
		await registerWorkspaceRoot(WIN_B, workspaceDir);
		const canonical = await canonicalize(join(workspaceDir, "x.md"));
		expect(findContainingWorkspaceRoot(WIN_A, canonical)).toBeNull();
		expect(findContainingWorkspaceRoot(WIN_B, canonical)).toBe(await canonicalize(workspaceDir));
	});
});
