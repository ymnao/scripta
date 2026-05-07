// @vitest-environment node
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

vi.mock("./settings", () => ({
	persistWorkspacePath: vi.fn(async () => {}),
}));

import { ipcMain } from "electron";
import { canonicalize, clearWorkspaceRoots, getWorkspaceRootsForWindow } from "../utils/path-guard";
import { persistWorkspacePath } from "./settings";
import {
	__testing,
	approveWorkspacePath,
	isWorkspacePathApproved,
	markWorkspacePersistenceVolatile,
	registerWorkspaceIpc,
} from "./workspace";

const {
	setActiveWorkspaceForWindow,
	unregisterWindow,
	getWindowWorkspaces,
	getApprovedWorkspacePaths,
	getVolatileWorkspacePersistenceWindows,
	reset,
} = __testing;

const WIN_A = 1;
const WIN_B = 2;

let dirA = "";
let dirB = "";

beforeEach(async () => {
	clearWorkspaceRoots();
	reset();
	dirA = await mkdtemp(join(tmpdir(), "scripta-ws-A-"));
	dirB = await mkdtemp(join(tmpdir(), "scripta-ws-B-"));
});

afterEach(async () => {
	clearWorkspaceRoots();
	reset();
	await rm(dirA, { recursive: true, force: true });
	await rm(dirB, { recursive: true, force: true });
});

describe("setActiveWorkspaceForWindow", () => {
	it("registers the workspace root under the window's own slot", () => {
		setActiveWorkspaceForWindow(WIN_A, dirA);
		expect(getWorkspaceRootsForWindow(WIN_A)).toHaveLength(1);
		expect(getWindowWorkspaces().get(WIN_A)).toBe(canonicalize(dirA));
	});

	it("does nothing if the window already has the same path", () => {
		setActiveWorkspaceForWindow(WIN_A, dirA);
		const before = getWorkspaceRootsForWindow(WIN_A);
		setActiveWorkspaceForWindow(WIN_A, dirA);
		expect(getWorkspaceRootsForWindow(WIN_A)).toEqual(before);
	});

	it("unregisters the previous path when a window switches", () => {
		setActiveWorkspaceForWindow(WIN_A, dirA);
		setActiveWorkspaceForWindow(WIN_A, dirB);
		const roots = getWorkspaceRootsForWindow(WIN_A);
		expect(roots).toHaveLength(1);
		expect(roots[0].endsWith(basename(dirB))).toBe(true);
	});

	it("clears the window's workspace when path is null", () => {
		setActiveWorkspaceForWindow(WIN_A, dirA);
		setActiveWorkspaceForWindow(WIN_A, null);
		expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([]);
		expect(getWindowWorkspaces().has(WIN_A)).toBe(false);
	});
});

describe("multi-window isolation", () => {
	it("does not leak one window's path to another window's allowedRoots view", () => {
		setActiveWorkspaceForWindow(WIN_A, dirA);
		setActiveWorkspaceForWindow(WIN_B, dirB);
		// 各 window は自分の roots だけを持つ
		expect(getWorkspaceRootsForWindow(WIN_A)).toHaveLength(1);
		expect(getWorkspaceRootsForWindow(WIN_B)).toHaveLength(1);
		expect(getWorkspaceRootsForWindow(WIN_A)[0]).toBe(canonicalize(dirA));
		expect(getWorkspaceRootsForWindow(WIN_B)[0]).toBe(canonicalize(dirB));
	});

	it("does not unregister another window's path when one window switches", () => {
		setActiveWorkspaceForWindow(WIN_A, dirA);
		setActiveWorkspaceForWindow(WIN_B, dirB);

		setActiveWorkspaceForWindow(WIN_A, null);
		expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([]);
		expect(getWorkspaceRootsForWindow(WIN_B)).toHaveLength(1);
	});

	it("registers the same path independently in each window", () => {
		// 旧設計の ref-count は撤廃。各 window が自分の Set に持つ
		setActiveWorkspaceForWindow(WIN_A, dirA);
		setActiveWorkspaceForWindow(WIN_B, dirA);
		expect(getWorkspaceRootsForWindow(WIN_A)).toHaveLength(1);
		expect(getWorkspaceRootsForWindow(WIN_B)).toHaveLength(1);
	});

	it("unregistering one window does not affect the other window even with shared path", () => {
		setActiveWorkspaceForWindow(WIN_A, dirA);
		setActiveWorkspaceForWindow(WIN_B, dirA);
		setActiveWorkspaceForWindow(WIN_A, null);
		expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([]);
		expect(getWorkspaceRootsForWindow(WIN_B)).toHaveLength(1);
	});
});

describe("unregisterWindow", () => {
	it("removes the window's workspace from its own allowedRoots", () => {
		setActiveWorkspaceForWindow(WIN_A, dirA);
		unregisterWindow(WIN_A);
		expect(getWorkspaceRootsForWindow(WIN_A)).toEqual([]);
		expect(getWindowWorkspaces().has(WIN_A)).toBe(false);
	});

	it("does not affect other windows' state", () => {
		setActiveWorkspaceForWindow(WIN_A, dirA);
		setActiveWorkspaceForWindow(WIN_B, dirA);
		unregisterWindow(WIN_A);
		expect(getWorkspaceRootsForWindow(WIN_B)).toHaveLength(1);
		expect(getWindowWorkspaces().get(WIN_B)).toBe(canonicalize(dirA));
	});

	it("is a no-op for an unknown window id", () => {
		setActiveWorkspaceForWindow(WIN_A, dirA);
		unregisterWindow(9999);
		expect(getWorkspaceRootsForWindow(WIN_A)).toHaveLength(1);
		expect(getWindowWorkspaces().get(WIN_A)).toBe(canonicalize(dirA));
	});
});

describe("markWorkspacePersistenceVolatile", () => {
	it("records the window id and is cleared by unregisterWindow", () => {
		markWorkspacePersistenceVolatile(WIN_A);
		expect(getVolatileWorkspacePersistenceWindows().has(WIN_A)).toBe(true);
		unregisterWindow(WIN_A);
		expect(getVolatileWorkspacePersistenceWindows().has(WIN_A)).toBe(false);
	});

	it("is cleared by reset()", () => {
		markWorkspacePersistenceVolatile(WIN_A);
		markWorkspacePersistenceVolatile(WIN_B);
		reset();
		expect(getVolatileWorkspacePersistenceWindows().size).toBe(0);
	});
});

describe("workspace:set IPC handler — persistence gating", () => {
	type Handler = (event: { sender: { id: number } }, path: string | null) => Promise<void>;

	const captureHandler = (): Handler => {
		registerWorkspaceIpc();
		const calls = vi.mocked(ipcMain.handle).mock.calls;
		const entry = calls.find(([channel]) => channel === "workspace:set");
		if (!entry) throw new Error("workspace:set was not registered");
		return entry[1] as unknown as Handler;
	};

	beforeEach(() => {
		vi.mocked(ipcMain.handle).mockReset();
		vi.mocked(persistWorkspacePath).mockClear();
	});

	it("non-volatile windows: persists workspacePath", async () => {
		approveWorkspacePath(dirA);
		const handler = captureHandler();
		await handler({ sender: { id: WIN_A } }, dirA);
		expect(vi.mocked(persistWorkspacePath)).toHaveBeenCalledWith(dirA);
		expect(getWindowWorkspaces().get(WIN_A)).toBe(canonicalize(dirA));
	});

	it("volatile windows (New Window): does NOT persist workspacePath but still registers in-memory", async () => {
		// 補助ウィンドウから picker でフォルダを開いた瞬間に settings.json の
		// 既定 workspacePath が上書きされるバグの回帰防止
		approveWorkspacePath(dirA);
		markWorkspacePersistenceVolatile(WIN_A);
		const handler = captureHandler();
		await handler({ sender: { id: WIN_A } }, dirA);
		expect(vi.mocked(persistWorkspacePath)).not.toHaveBeenCalled();
		expect(getWindowWorkspaces().get(WIN_A)).toBe(canonicalize(dirA));
	});

	it("rejects unapproved path even for volatile windows", async () => {
		// volatile が approve バイパスにならないこと（信頼境界の確認）
		markWorkspacePersistenceVolatile(WIN_A);
		const handler = captureHandler();
		await expect(handler({ sender: { id: WIN_A } }, dirA)).rejects.toThrow(/Permission denied/);
		expect(vi.mocked(persistWorkspacePath)).not.toHaveBeenCalled();
	});

	it("after unregisterWindow, the same id is no longer volatile and persists again", async () => {
		approveWorkspacePath(dirA);
		markWorkspacePersistenceVolatile(WIN_A);
		unregisterWindow(WIN_A);
		const handler = captureHandler();
		await handler({ sender: { id: WIN_A } }, dirA);
		expect(vi.mocked(persistWorkspacePath)).toHaveBeenCalledTimes(1);
	});

	it("path === null (unregister) is allowed and gated by volatility flag", async () => {
		setActiveWorkspaceForWindow(WIN_A, dirA);
		markWorkspacePersistenceVolatile(WIN_A);
		const handler = captureHandler();
		await handler({ sender: { id: WIN_A } }, null);
		// volatile なので null も persist されない
		expect(vi.mocked(persistWorkspacePath)).not.toHaveBeenCalled();
		expect(getWindowWorkspaces().has(WIN_A)).toBe(false);
	});
});

describe("approveWorkspacePath / isWorkspacePathApproved", () => {
	it("approves a path and stores it in canonical form", () => {
		approveWorkspacePath(dirA);
		expect(getApprovedWorkspacePaths().has(canonicalize(dirA))).toBe(true);
	});

	it("isWorkspacePathApproved returns true for an approved path", () => {
		approveWorkspacePath(dirA);
		expect(isWorkspacePathApproved(dirA)).toBe(true);
	});

	it("isWorkspacePathApproved returns false for an unapproved path", () => {
		expect(isWorkspacePathApproved(dirA)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"treats symlink-aliased paths as the same approval (canonical compare)",
		async () => {
			const link = join(tmpdir(), `scripta-ws-approve-link-${Date.now()}-${Math.random()}`);
			await symlink(dirA, link);
			try {
				approveWorkspacePath(dirA);
				expect(isWorkspacePathApproved(link)).toBe(true);
			} finally {
				await rm(link, { force: true });
			}
		},
	);

	it("returns false for invalid input (relative path / null byte) without throwing", () => {
		expect(isWorkspacePathApproved("relative/path")).toBe(false);
		expect(isWorkspacePathApproved("/tmp/\0evil")).toBe(false);
	});

	it("reset() clears approved paths along with windowWorkspaces", () => {
		approveWorkspacePath(dirA);
		expect(getApprovedWorkspacePaths().size).toBe(1);
		reset();
		expect(getApprovedWorkspacePaths().size).toBe(0);
	});
});
