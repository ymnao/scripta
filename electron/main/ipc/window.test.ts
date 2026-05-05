// @vitest-environment node
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BrowserWindow / ipcMain / app / session を最小限にスタブ化する。
// `createConflictWindow` は new BrowserWindow → loadURL を呼ぶので、
// インスタンスを記録する factory を mock として組む。
type FakeWindow = {
	webContents: { id: number };
	loadURL: ReturnType<typeof vi.fn>;
	loadFile: ReturnType<typeof vi.fn>;
	focus: ReturnType<typeof vi.fn>;
	restore: ReturnType<typeof vi.fn>;
	isDestroyed: ReturnType<typeof vi.fn>;
	isMinimized: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	show: ReturnType<typeof vi.fn>;
	__opts: unknown;
	__id: number;
};

// vi.mock factory はファイル先頭にホイストされるため、参照する変数も `vi.hoisted`
// で同様にホイストして定義しないと "Cannot access X before initialization" になる。
const { createdWindows, createFakeWindow } = vi.hoisted(() => {
	const list: FakeWindow[] = [];
	let nextId = 1000;
	const create = (opts: unknown): FakeWindow => {
		const id = nextId++;
		const win: FakeWindow = {
			webContents: { id },
			loadURL: vi.fn(async () => {}),
			loadFile: vi.fn(async () => {}),
			focus: vi.fn(),
			restore: vi.fn(),
			isDestroyed: vi.fn(() => false),
			isMinimized: vi.fn(() => false),
			on: vi.fn(),
			show: vi.fn(),
			__opts: opts,
			__id: id,
		};
		list.push(win);
		return win;
	};
	return { createdWindows: list, createFakeWindow: create };
});

vi.mock("electron", () => {
	// `new BrowserWindow(opts)` を捕捉するため Proxy で construct trap を仕込む。
	// arrow function は構築不可、function expression は useArrowFunction lint、
	// 値を return する class constructor は noConstructorReturn lint に当たる。
	// Proxy の construct trap は target が constructable function である必要が
	// あるため、空の class を target に使う。
	const ProxyTarget = class {};
	const statics = {
		fromId: (_id: number) => null,
		getAllWindows: () => createdWindows,
	};
	const MockBrowserWindow = new Proxy(ProxyTarget, {
		construct(_target, args) {
			return createFakeWindow(args[0]) as unknown as object;
		},
		get(_target, prop) {
			return (statics as Record<string | symbol, unknown>)[prop as string];
		},
	});
	return {
		BrowserWindow: MockBrowserWindow,
		ipcMain: { handle: vi.fn() },
		app: { getVersion: () => "0.0.0" },
		session: { defaultSession: { clearStorageData: vi.fn(async () => {}) } },
	};
});

import { clearWorkspaceRoots, registerWorkspaceRoot } from "../utils/path-guard";
import { __testing as windowTesting } from "./window";
import { __testing as workspaceTesting } from "./workspace";

const { createConflictWindow, conflictWindows } = windowTesting;

const PARENT_WIN = 1;

let workspaceDir = "";

beforeEach(async () => {
	clearWorkspaceRoots();
	workspaceTesting.reset();
	conflictWindows.clear();
	createdWindows.length = 0;
	workspaceDir = await realpath(await mkdtemp(join(tmpdir(), "scripta-window-test-")));
	// parent window の allowedRoots に workspace を登録
	registerWorkspaceRoot(PARENT_WIN, workspaceDir);
});

afterEach(async () => {
	clearWorkspaceRoots();
	workspaceTesting.reset();
	conflictWindows.clear();
	await rm(workspaceDir, { recursive: true, force: true });
});

describe("createConflictWindow", () => {
	it("rejects when workspace is not in parent allowedRoots", async () => {
		// parent に登録されていない別 path
		const stranger = await realpath(await mkdtemp(join(tmpdir(), "scripta-window-other-")));
		try {
			await expect(createConflictWindow(PARENT_WIN, stranger)).rejects.toThrow(/Permission denied/);
		} finally {
			await rm(stranger, { recursive: true, force: true });
		}
	});

	it("creates a window and registers workspace for the new window's id", async () => {
		await createConflictWindow(PARENT_WIN, workspaceDir);
		expect(createdWindows).toHaveLength(1);
		const childId = createdWindows[0].webContents.id;
		// 子 window 向けに workspace が登録されていること
		expect(workspaceTesting.getWindowWorkspaces().get(childId)).toBe(workspaceDir);
	});

	it("loads URL with conflict=true and encoded workspacePath", async () => {
		// dev 経路をシミュレートするため ELECTRON_RENDERER_URL を一時設定
		const original = process.env.ELECTRON_RENDERER_URL;
		process.env.ELECTRON_RENDERER_URL = "http://localhost:5173";
		try {
			await createConflictWindow(PARENT_WIN, workspaceDir);
			const win = createdWindows[0];
			expect(win.loadURL).toHaveBeenCalledTimes(1);
			const arg = win.loadURL.mock.calls[0][0] as string;
			expect(arg).toMatch(/\?conflict=true&workspacePath=/);
			expect(arg).toContain(encodeURIComponent(workspaceDir));
		} finally {
			if (original === undefined) delete process.env.ELECTRON_RENDERER_URL;
			else process.env.ELECTRON_RENDERER_URL = original;
		}
	});

	it("uses loadFile in production (no ELECTRON_RENDERER_URL)", async () => {
		const original = process.env.ELECTRON_RENDERER_URL;
		delete process.env.ELECTRON_RENDERER_URL;
		try {
			await createConflictWindow(PARENT_WIN, workspaceDir);
			const win = createdWindows[0];
			expect(win.loadFile).toHaveBeenCalledTimes(1);
			const [, opts] = win.loadFile.mock.calls[0];
			expect(opts).toMatchObject({
				search: expect.stringMatching(/^\?conflict=true&workspacePath=/),
			});
		} finally {
			if (original !== undefined) process.env.ELECTRON_RENDERER_URL = original;
		}
	});

	it("focuses existing window when called twice for the same workspace (single instance)", async () => {
		await createConflictWindow(PARENT_WIN, workspaceDir);
		expect(createdWindows).toHaveLength(1);
		await createConflictWindow(PARENT_WIN, workspaceDir);
		// 2 回目では new していないこと
		expect(createdWindows).toHaveLength(1);
		expect(createdWindows[0].focus).toHaveBeenCalledTimes(1);
	});

	it("restores minimized window before focusing", async () => {
		await createConflictWindow(PARENT_WIN, workspaceDir);
		const win = createdWindows[0];
		win.isMinimized.mockReturnValue(true);
		await createConflictWindow(PARENT_WIN, workspaceDir);
		expect(win.restore).toHaveBeenCalledTimes(1);
		expect(win.focus).toHaveBeenCalledTimes(1);
	});
});
