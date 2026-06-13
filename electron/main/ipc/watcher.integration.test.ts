// @vitest-environment node
//
// watcher.ts の **race / 寿命管理** を直接叩く統合テスト。
// pure helper のテストは watcher.test.ts 側で行っており、ここでは chokidar を
// 偽装して「stop 後に late event が来てもイベントが renderer に届かない」
// 「再 start 後の旧 session からの late event がリークしない」を確認する。
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSymlinkedWorkspace } from "../test-utils/temp-workspace";

// chokidar.watch() が返す本物の代わりに使う EventEmitter ベースの偽 watcher。
// テストから add/change/unlink を任意タイミングで emit できる。
class FakeWatcher extends EventEmitter {
	closeResolve!: () => void;
	closePromise: Promise<void>;
	close = vi.fn(() => this.closePromise);
	constructor() {
		super();
		this.closePromise = new Promise<void>((res) => {
			this.closeResolve = res;
		});
	}
}

const createdWatchers: FakeWatcher[] = [];

vi.mock("chokidar", () => ({
	default: {
		watch: vi.fn(() => {
			const w = new FakeWatcher();
			createdWatchers.push(w);
			return w;
		}),
	},
}));

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { ipcMain } from "electron";
import { clearWorkspaceRoots, registerWorkspaceRoot } from "../utils/path-guard";
import { registerWatcherIpc, stopWatcherForWindow } from "./watcher";

// fake event を渡せるよう、production の `(event: IpcMainInvokeEvent, ...) => ...`
// を緩い型にキャストする helper。production 側は event.sender.id しか参照しないので、
// FakeWebContents だけ持つ最小オブジェクトを sender として渡す。
type LooseHandler = (...args: unknown[]) => Promise<unknown>;

interface FakeWebContents {
	id: number;
	send: ReturnType<typeof vi.fn>;
	isDestroyed: () => boolean;
}

function getHandler(channel: string): LooseHandler {
	const calls = vi.mocked(ipcMain.handle).mock.calls;
	for (const [registered, handler] of calls) {
		if (registered === channel) return handler as unknown as LooseHandler;
	}
	throw new Error(`handler not registered: ${channel}`);
}

const TEST_WIN = 1;
let webContents: FakeWebContents;

// 共通セットアップ: fake timers / ipcMain mock / webContents / registerWatcherIpc。
// workspace root の登録は各 describe の beforeEach で行う（テストごとに必要な root が異なるため）。
beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(ipcMain.handle).mockClear();
	createdWatchers.length = 0;
	clearWorkspaceRoots();
	webContents = {
		id: TEST_WIN,
		send: vi.fn(),
		isDestroyed: vi.fn(() => false),
	};
	registerWatcherIpc();
});

afterEach(() => {
	vi.useRealTimers();
});

// cleanup 順序は「watcher 停止 → workspace 解除 → 物理 dir 削除」で固定する。
// 現状の FakeWatcher では順序逆転しても観測できないが、将来 fake watcher の close に
// 副作用を足したり一部を実 watcher 寄りにした際に失敗原因の切り分けが鈍るのを避ける。
describe("watcher.ts: start/stop race", () => {
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "scripta-watcher-int-"));
		await registerWorkspaceRoot(TEST_WIN, workspaceDir);
	});

	afterEach(async () => {
		stopWatcherForWindow(TEST_WIN);
		clearWorkspaceRoots();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	it("delivers fs-change on the happy path (before stop)", async () => {
		const start = getHandler("watcher:start");
		await start({ sender: webContents }, workspaceDir);
		expect(createdWatchers).toHaveLength(1);

		createdWatchers[0].emit("add", join(workspaceDir, "a.md"));
		await vi.advanceTimersByTimeAsync(600);

		expect(webContents.send).toHaveBeenCalledTimes(1);
		expect(webContents.send).toHaveBeenCalledWith("watcher:fs-change", [
			{ kind: "create", path: join(workspaceDir, "a.md") },
		]);
	});

	it("does NOT deliver events that arrive after stopWatcherForWindow", async () => {
		const start = getHandler("watcher:start");
		await start({ sender: webContents }, workspaceDir);
		const w = createdWatchers[0];

		// stop は synchronous に session.stopped = true を立てる
		stopWatcherForWindow(TEST_WIN);

		// chokidar.close() の解決前に listener closure 経由で late event が飛ぶ状況を再現
		w.emit("add", join(workspaceDir, "late.md"));
		w.emit("change", join(workspaceDir, "another-late.md"));
		await vi.advanceTimersByTimeAsync(600);

		expect(webContents.send).not.toHaveBeenCalled();
	});

	it("does NOT leak old session's late events after watcher:start replaces it", async () => {
		const start = getHandler("watcher:start");
		await start({ sender: webContents }, workspaceDir);
		const oldWatcher = createdWatchers[0];

		// 同じ window で再 start すると内部で stopWatcherForWindow が走り旧 session.stopped = true
		await start({ sender: webContents }, workspaceDir);
		expect(createdWatchers).toHaveLength(2);
		const freshWatcher = createdWatchers[1];
		expect(freshWatcher).not.toBe(oldWatcher);

		// 旧 watcher からの late event は届いてはいけない
		oldWatcher.emit("add", join(workspaceDir, "stale.md"));
		await vi.advanceTimersByTimeAsync(600);
		expect(webContents.send).not.toHaveBeenCalled();

		// 新 watcher の event は通常通り 500ms 後に届く
		freshWatcher.emit("add", join(workspaceDir, "fresh.md"));
		await vi.advanceTimersByTimeAsync(600);
		expect(webContents.send).toHaveBeenCalledTimes(1);
		expect(webContents.send).toHaveBeenCalledWith("watcher:fs-change", [
			{ kind: "create", path: join(workspaceDir, "fresh.md") },
		]);
	});

	it("does NOT call send when webContents is already destroyed at flush time", async () => {
		const start = getHandler("watcher:start");
		await start({ sender: webContents }, workspaceDir);

		createdWatchers[0].emit("add", join(workspaceDir, "a.md"));
		// flush 前に window が消えたケース
		webContents.isDestroyed = vi.fn(() => true);
		await vi.advanceTimersByTimeAsync(600);

		expect(webContents.send).not.toHaveBeenCalled();
	});

	it("watcher:stop handler also short-circuits late events", async () => {
		const start = getHandler("watcher:start");
		const stop = getHandler("watcher:stop");
		await start({ sender: webContents }, workspaceDir);
		const w = createdWatchers[0];

		await stop({ sender: webContents });

		w.emit("add", join(workspaceDir, "post-stop.md"));
		await vi.advanceTimersByTimeAsync(600);

		expect(webContents.send).not.toHaveBeenCalled();
	});

	it("rejects watcher:start for unauthorized path (path-guard)", async () => {
		const start = getHandler("watcher:start");
		const otherDir = await mkdtemp(join(tmpdir(), "scripta-other-"));
		try {
			await expect(start({ sender: webContents }, otherDir)).rejects.toThrow(/Permission denied/);
			expect(createdWatchers).toHaveLength(0);
		} finally {
			await rm(otherDir, { recursive: true, force: true });
		}
	});
});

// 回帰テスト：renderer 側はタブ/FileTree で input 表記の path を保持しているため、
// canonical（realpath 済み）の path をそのまま emit すると比較が一致せず外部変更検知が
// 壊れる。macOS の /var → /private/var alias や、symlink 経由で workspace を開いた
// ケースで顕在化する。fs.ts/listDirectoryImpl, search.ts と同じく canonical I/O →
// input emit に統一する必要がある。
describe("watcher.ts: symlinked workspace", () => {
	let canonicalRealDir: string;
	let symlinkDir: string;
	let cleanupWorkspace = () => Promise.resolve();

	beforeEach(async () => {
		({
			canonicalRealDir,
			symlinkDir,
			cleanup: cleanupWorkspace,
		} = await createSymlinkedWorkspace());
		await registerWorkspaceRoot(TEST_WIN, symlinkDir);
	});

	afterEach(async () => {
		stopWatcherForWindow(TEST_WIN);
		clearWorkspaceRoots();
		await cleanupWorkspace();
	});

	// Windows は symlink に Developer Mode が必要で CI が EPERM になるためスキップ。
	it.skipIf(process.platform === "win32")(
		"emits input-form paths even when chokidar reports canonical",
		async () => {
			const start = getHandler("watcher:start");
			await start({ sender: webContents }, symlinkDir);
			expect(createdWatchers).toHaveLength(1);

			// 実 chokidar は canonical 配下の path を emit する。
			// reclassifyDeleted の挙動を避けるため kind は create/delete のみ使う
			// （modify は disk 実体を見て delete 化される可能性があり、本テストの焦点外）。
			createdWatchers[0].emit("add", join(canonicalRealDir, "note.md"));
			createdWatchers[0].emit("unlink", join(canonicalRealDir, "sub", "deep.md"));
			await vi.advanceTimersByTimeAsync(600);

			expect(webContents.send).toHaveBeenCalledTimes(1);
			expect(webContents.send).toHaveBeenCalledWith("watcher:fs-change", [
				{ kind: "create", path: join(symlinkDir, "note.md") },
				{ kind: "delete", path: join(symlinkDir, "sub", "deep.md") },
			]);
		},
	);
});
