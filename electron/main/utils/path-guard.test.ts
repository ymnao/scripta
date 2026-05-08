// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	assertPathAllowed,
	assertWritePathAllowed,
	canonicalize,
	clearTransientWritePathsForWindow,
	clearWorkspaceRoots,
	clearWorkspaceRootsForWindow,
	consumeTransientWritePath,
	getTransientWritePathsForWindow,
	getWorkspaceRootsForWindow,
	isPathAllowed,
	isPathWithinAnyAllowedRoot,
	registerTransientWritePath,
	registerWorkspaceRoot,
	unregisterWorkspaceRoot,
	validatePath,
} from "./path-guard";

const WIN_A = 1;
const WIN_B = 2;

let workspaceDir = "";
let outsideDir = "";

beforeEach(async () => {
	clearWorkspaceRoots();
	workspaceDir = await mkdtemp(join(tmpdir(), "scripta-pg-ws-"));
	outsideDir = await mkdtemp(join(tmpdir(), "scripta-pg-out-"));
});

afterEach(async () => {
	clearWorkspaceRoots();
	await rm(workspaceDir, { recursive: true, force: true });
	await rm(outsideDir, { recursive: true, force: true });
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
	it("registers a realpath-resolved root under a window", () => {
		registerWorkspaceRoot(WIN_A, workspaceDir);
		const roots = getWorkspaceRootsForWindow(WIN_A);
		expect(roots).toHaveLength(1);
		// macOS では /var → /private/var など symlink が解消される
		expect(roots[0].endsWith(basename(workspaceDir))).toBe(true);
	});

	it("unregisters a root from a window", () => {
		registerWorkspaceRoot(WIN_A, workspaceDir);
		unregisterWorkspaceRoot(WIN_A, workspaceDir);
		expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([]);
	});

	it("clears all roots across windows", () => {
		registerWorkspaceRoot(WIN_A, workspaceDir);
		registerWorkspaceRoot(WIN_B, outsideDir);
		clearWorkspaceRoots();
		expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([]);
		expect(getWorkspaceRootsForWindow(WIN_B)).toEqual([]);
	});

	it("clearWorkspaceRootsForWindow removes only one window's roots", () => {
		registerWorkspaceRoot(WIN_A, workspaceDir);
		registerWorkspaceRoot(WIN_B, outsideDir);
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
		() => {
			const phantom = "/this/path/does/not/exist";
			registerWorkspaceRoot(WIN_A, phantom);
			expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([phantom]);
		},
	);
});

describe("isPathAllowed (window-scoped)", () => {
	it("denies everything when the window has no roots (fail-closed)", () => {
		// アプリ起動直後 / ワークスペース未選択時に任意 path へのアクセスを許してしまう
		// 抜け穴を防ぐ
		expect(isPathAllowed(WIN_A, "/anywhere/file")).toBe(false);
		expect(isPathAllowed(WIN_A, "/etc/passwd")).toBe(false);
	});

	it("does NOT see roots registered to a different window", () => {
		// ウィンドウ A の renderer が ウィンドウ B の workspace 配下を read/list/rename/
		// delete できてしまう回帰を防ぐ
		registerWorkspaceRoot(WIN_B, workspaceDir);
		const file = join(workspaceDir, "f.md");
		expect(isPathAllowed(WIN_A, file)).toBe(false);
		expect(() => assertPathAllowed(WIN_A, file)).toThrow(/Permission denied/);
		// 当該 window は通る
		expect(isPathAllowed(WIN_B, file)).toBe(true);
	});

	it("isPathAllowed returns false for invalid input (boolean contract)", () => {
		// validatePath が throw する系のフォールバックは false に寄せる：
		// 呼び出し側は「許可されているか?」のクエリとして使うため、boolean 契約を保つ
		expect(isPathAllowed(WIN_A, "relative/path")).toBe(false);
		expect(isPathAllowed(WIN_A, "")).toBe(false);
		expect(isPathAllowed(WIN_A, "/tmp/\0evil")).toBe(false);
	});

	it("assertPathAllowed propagates validate errors as 'Invalid path: ...'", () => {
		// 呼び出し側で「不正入力」と「権限エラー」を区別できるように、
		// validate エラーは Invalid path として throw する
		expect(() => assertPathAllowed(WIN_A, "relative/path")).toThrow(
			/Invalid path: must be absolute/,
		);
		expect(() => assertPathAllowed(WIN_A, "")).toThrow(/Invalid path: empty/);
	});

	it("allows files inside the window's workspace", async () => {
		const file = join(workspaceDir, "f.md");
		await writeFile(file, "x", "utf8");
		registerWorkspaceRoot(WIN_A, workspaceDir);
		expect(isPathAllowed(WIN_A, file)).toBe(true);
	});

	it("rejects files outside the workspace", async () => {
		const outsideFile = join(outsideDir, "secret");
		await writeFile(outsideFile, "x", "utf8");
		registerWorkspaceRoot(WIN_A, workspaceDir);
		expect(isPathAllowed(WIN_A, outsideFile)).toBe(false);
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
			registerWorkspaceRoot(WIN_A, workspaceDir);
			expect(isPathAllowed(WIN_A, target)).toBe(false);
		},
	);

	it("allows paths inside the workspace even before the file exists", () => {
		registerWorkspaceRoot(WIN_A, workspaceDir);
		const newPath = join(workspaceDir, "subdir", "new.md");
		expect(isPathAllowed(WIN_A, newPath)).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"blocks symlink-based escape via intermediate directories",
		async () => {
			const link = join(workspaceDir, "escape");
			await symlink(outsideDir, link);
			registerWorkspaceRoot(WIN_A, workspaceDir);
			const evil = join(link, "new-file.md");
			expect(isPathAllowed(WIN_A, evil)).toBe(false);
		},
	);

	it("allows paths inside any of multiple roots registered to the same window", async () => {
		const second = await mkdtemp(join(tmpdir(), "scripta-pg-ws2-"));
		try {
			registerWorkspaceRoot(WIN_A, workspaceDir);
			registerWorkspaceRoot(WIN_A, second);
			expect(isPathAllowed(WIN_A, join(workspaceDir, "a.md"))).toBe(true);
			expect(isPathAllowed(WIN_A, join(second, "b.md"))).toBe(true);
			expect(isPathAllowed(WIN_A, join(outsideDir, "c.md"))).toBe(false);
		} finally {
			await rm(second, { recursive: true, force: true });
		}
	});

	it("does not falsely match sibling directories sharing a name prefix", async () => {
		const sibling = await mkdtemp(join(tmpdir(), "scripta-pg-ws-"));
		try {
			registerWorkspaceRoot(WIN_A, workspaceDir);
			expect(isPathAllowed(WIN_A, join(sibling, "f.md"))).toBe(false);
		} finally {
			await rm(sibling, { recursive: true, force: true });
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
			registerWorkspaceRoot(WIN_A, workspaceDir);
			expect(isPathAllowed(WIN_A, target)).toBe(true);
		} finally {
			await rm(dotDir, { recursive: true, force: true });
		}
	});
});

describe("isPathWithinAnyAllowedRoot (process-wide)", () => {
	it("returns false when no window has registered any root (fail-closed)", () => {
		expect(isPathWithinAnyAllowedRoot("/anywhere/file")).toBe(false);
	});

	it("returns true if any window has registered a root containing the path", async () => {
		const file = join(workspaceDir, "img.png");
		await writeFile(file, "x", "utf8");
		registerWorkspaceRoot(WIN_B, workspaceDir);
		// scripta-asset:// プロトコルハンドラはどの window から発行されたかを区別できない
		// ため、union として B 登録の root を A からのリクエストでも見える形で OK にする
		expect(isPathWithinAnyAllowedRoot(file)).toBe(true);
	});

	it("returns false for paths outside any registered root", async () => {
		const outsideFile = join(outsideDir, "leak.png");
		await writeFile(outsideFile, "x", "utf8");
		registerWorkspaceRoot(WIN_A, workspaceDir);
		expect(isPathWithinAnyAllowedRoot(outsideFile)).toBe(false);
	});

	it("returns false for invalid input (boolean contract)", () => {
		expect(isPathWithinAnyAllowedRoot("relative/path")).toBe(false);
		expect(isPathWithinAnyAllowedRoot("")).toBe(false);
		expect(isPathWithinAnyAllowedRoot("/tmp/\0evil")).toBe(false);
	});

	// fs.symlink は Windows で Developer Mode 無効時に EPERM になるため skip
	it.skipIf(process.platform === "win32")(
		"blocks symlink-based escape from any registered workspace",
		async () => {
			const link = join(workspaceDir, "escape");
			await symlink(outsideDir, link);
			const target = join(link, "secret.png");
			await writeFile(target, "leaked", "utf8");
			registerWorkspaceRoot(WIN_A, workspaceDir);
			expect(isPathWithinAnyAllowedRoot(target)).toBe(false);
		},
	);
});

describe("assertPathAllowed (window-scoped)", () => {
	it("does not throw inside the window's workspace", async () => {
		const file = join(workspaceDir, "f.md");
		await writeFile(file, "x", "utf8");
		registerWorkspaceRoot(WIN_A, workspaceDir);
		expect(() => assertPathAllowed(WIN_A, file)).not.toThrow();
		expect(() => assertPathAllowed(WIN_A, join(workspaceDir, "new.md"))).not.toThrow();
	});

	it("throws a generic Permission denied error WITHOUT leaking the path", async () => {
		registerWorkspaceRoot(WIN_A, workspaceDir);
		const offendingPath = join(outsideDir, "secret");
		expect(() => assertPathAllowed(WIN_A, offendingPath)).toThrow(
			/^Permission denied: outside workspace$/,
		);
		try {
			assertPathAllowed(WIN_A, offendingPath);
		} catch (e) {
			expect((e as Error).message).not.toContain(offendingPath);
			expect((e as Error).message).not.toContain(outsideDir);
		}
	});

	it("logs the offending path to console.warn but not to the thrown Error", async () => {
		registerWorkspaceRoot(WIN_A, workspaceDir);
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(() => assertPathAllowed(WIN_A, join(outsideDir, "x"))).toThrow();
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0][0]).toContain("[path-guard]");
			expect(spy.mock.calls[0][0]).toContain(outsideDir);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("transient write paths (window-scoped, write-only capability)", () => {
	it("isPathAllowed (read guard) does NOT see transient paths", () => {
		const target = join(outsideDir, "export.html");
		registerTransientWritePath(WIN_A, target);
		// transient は write 専用 capability。read 系では参照されない
		expect(isPathAllowed(WIN_A, target)).toBe(false);
		expect(() => assertPathAllowed(WIN_A, target)).toThrow(/Permission denied/);
	});

	it("assertWritePathAllowed permits a transient path without consuming it", () => {
		const target = join(outsideDir, "export.html");
		registerTransientWritePath(WIN_A, target);
		expect(getTransientWritePathsForWindow(WIN_A)).toHaveLength(1);

		// withRetry の再試行を想定して同じ window から複数回チェック → 全て通る
		expect(() => assertWritePathAllowed(WIN_A, target)).not.toThrow();
		expect(() => assertWritePathAllowed(WIN_A, target)).not.toThrow();
		// チェックだけでは consume されない
		expect(getTransientWritePathsForWindow(WIN_A)).toHaveLength(1);
	});

	it("consumeTransientWritePath removes the path only after explicit consume", () => {
		const target = join(outsideDir, "export.html");
		registerTransientWritePath(WIN_A, target);
		// consumeTransientWritePath は canonical 前提 API なので、呼び出し側は
		// canonicalize() の結果を渡す（fs.ts は assertWritePathAllowed の戻り値を渡す）
		expect(consumeTransientWritePath(WIN_A, canonicalize(target))).toBe(true);
		expect(getTransientWritePathsForWindow(WIN_A)).toEqual([]);
		expect(consumeTransientWritePath(WIN_A, canonicalize(target))).toBe(false);
	});

	it("permits write via workspace root regardless of transient state", () => {
		registerWorkspaceRoot(WIN_A, workspaceDir);
		const wsFile = join(workspaceDir, "f.md");
		expect(() => assertWritePathAllowed(WIN_A, wsFile)).not.toThrow();
	});

	it("isolates transient paths per window (no cross-window consumption)", () => {
		const target = join(outsideDir, "export.html");
		registerTransientWritePath(WIN_A, target);
		expect(() => assertWritePathAllowed(WIN_B, target)).toThrow(/Permission denied/);
		expect(getTransientWritePathsForWindow(WIN_B)).toEqual([]);
		expect(() => assertWritePathAllowed(WIN_A, target)).not.toThrow();
	});

	it("clearTransientWritePathsForWindow removes only that window's paths", () => {
		registerTransientWritePath(WIN_A, join(outsideDir, "a.html"));
		registerTransientWritePath(WIN_B, join(outsideDir, "b.html"));
		clearTransientWritePathsForWindow(WIN_A);
		expect(getTransientWritePathsForWindow(WIN_A)).toEqual([]);
		expect(getTransientWritePathsForWindow(WIN_B)).toHaveLength(1);
	});

	it("clearWorkspaceRootsForWindow also wipes transient paths for that window", () => {
		registerWorkspaceRoot(WIN_A, workspaceDir);
		registerTransientWritePath(WIN_A, join(outsideDir, "x.html"));
		clearWorkspaceRootsForWindow(WIN_A);
		expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([]);
		expect(getTransientWritePathsForWindow(WIN_A)).toEqual([]);
	});

	it("clearWorkspaceRoots also wipes transient paths for all windows (test reset)", () => {
		registerTransientWritePath(WIN_A, join(outsideDir, "a.html"));
		registerTransientWritePath(WIN_B, join(outsideDir, "b.html"));
		clearWorkspaceRoots();
		expect(getTransientWritePathsForWindow(WIN_A)).toEqual([]);
		expect(getTransientWritePathsForWindow(WIN_B)).toEqual([]);
	});
});
