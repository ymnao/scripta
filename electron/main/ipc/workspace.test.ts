// @vitest-environment node
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	ipcMain: { handle: vi.fn() },
}));

import { canonicalize, clearWorkspaceRoots, getWorkspaceRoots } from "../utils/path-guard";
import { __testing, approveWorkspacePath, isWorkspacePathApproved } from "./workspace";

const {
	setActiveWorkspaceForWindow,
	unregisterWindow,
	getWindowWorkspaces,
	getApprovedWorkspacePaths,
	reset,
} = __testing;

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
	it("registers a workspace root for a window", () => {
		setActiveWorkspaceForWindow(1, dirA);
		expect(getWorkspaceRoots()).toHaveLength(1);
		expect(getWindowWorkspaces().get(1)).toBe(canonicalize(dirA));
	});

	it("does nothing if the window already has the same path", () => {
		setActiveWorkspaceForWindow(1, dirA);
		const rootsBefore = getWorkspaceRoots();
		setActiveWorkspaceForWindow(1, dirA);
		expect(getWorkspaceRoots()).toEqual(rootsBefore);
	});

	it("unregisters the previous path when a window switches", () => {
		setActiveWorkspaceForWindow(1, dirA);
		setActiveWorkspaceForWindow(1, dirB);
		expect(getWorkspaceRoots()).toHaveLength(1);
		// dirA が消え、dirB だけが残る
		const roots = getWorkspaceRoots();
		expect(roots[0].endsWith(dirB.split("/").slice(-1)[0])).toBe(true);
	});

	it("clears the window's workspace when path is null", () => {
		setActiveWorkspaceForWindow(1, dirA);
		setActiveWorkspaceForWindow(1, null);
		expect(getWorkspaceRoots()).toEqual([]);
		expect(getWindowWorkspaces().has(1)).toBe(false);
	});
});

describe("multi-window isolation", () => {
	it("does not unregister another window's path when one window switches", () => {
		setActiveWorkspaceForWindow(1, dirA);
		setActiveWorkspaceForWindow(2, dirB);
		expect(getWorkspaceRoots()).toHaveLength(2);

		// window 1 が path を変えても window 2 の dirB は残る
		setActiveWorkspaceForWindow(1, null);
		expect(getWorkspaceRoots()).toHaveLength(1);
		expect(getWindowWorkspaces().get(2)).toBe(canonicalize(dirB));
	});

	it("registers a path only once when shared by multiple windows", () => {
		setActiveWorkspaceForWindow(1, dirA);
		setActiveWorkspaceForWindow(2, dirA);
		// 同じ path が 2 window に紐付いているが、allowedRoots には 1 件のみ
		expect(getWorkspaceRoots()).toHaveLength(1);
	});

	it("keeps the shared path registered until the last window releases it (ref-count)", () => {
		setActiveWorkspaceForWindow(1, dirA);
		setActiveWorkspaceForWindow(2, dirA);
		expect(getWorkspaceRoots()).toHaveLength(1);

		setActiveWorkspaceForWindow(1, null);
		// window 2 がまだ dirA を使っているので残る
		expect(getWorkspaceRoots()).toHaveLength(1);

		setActiveWorkspaceForWindow(2, null);
		// 全 window が手放したので unregister
		expect(getWorkspaceRoots()).toEqual([]);
	});

	// fs.symlink は Windows で Developer Mode 無効時に EPERM になる。skip して
	// macOS / Linux でのみ symlink 検証を行う。
	it.skipIf(process.platform === "win32")(
		"ref-counts via canonical path so symlink-aliased paths share the same slot",
		async () => {
			// dirA を指す symlink を作り、別ウィンドウから symlink パス経由で workspace を申告する。
			// raw 文字列で比較していると「2 つの別 path」と見なされ、片方が手放した瞬間に
			// もう一方がまだ使っているのに unregister されてしまう（今回の修正対象の事故シナリオ）。
			const link = join(tmpdir(), `scripta-ws-link-${Date.now()}-${Math.random()}`);
			await symlink(dirA, link);
			try {
				setActiveWorkspaceForWindow(1, dirA);
				setActiveWorkspaceForWindow(2, link);
				// 同じ実体を指すので allowedRoots は 1 件のみ
				expect(getWorkspaceRoots()).toHaveLength(1);

				setActiveWorkspaceForWindow(1, null);
				// window 2 が symlink 経由でまだ使っているので、root は残るべき
				expect(getWorkspaceRoots()).toHaveLength(1);

				setActiveWorkspaceForWindow(2, null);
				expect(getWorkspaceRoots()).toEqual([]);
			} finally {
				await rm(link, { force: true });
			}
		},
	);
});

describe("unregisterWindow", () => {
	it("removes the window's workspace from allowedRoots if no other window uses it", () => {
		setActiveWorkspaceForWindow(1, dirA);
		unregisterWindow(1);
		expect(getWorkspaceRoots()).toEqual([]);
		expect(getWindowWorkspaces().has(1)).toBe(false);
	});

	it("keeps the path registered if another window still uses it", () => {
		setActiveWorkspaceForWindow(1, dirA);
		setActiveWorkspaceForWindow(2, dirA);
		unregisterWindow(1);
		expect(getWorkspaceRoots()).toHaveLength(1);
		expect(getWindowWorkspaces().get(2)).toBe(canonicalize(dirA));
	});

	it("is a no-op for an unknown window id", () => {
		setActiveWorkspaceForWindow(1, dirA);
		unregisterWindow(999);
		expect(getWorkspaceRoots()).toHaveLength(1);
		expect(getWindowWorkspaces().get(1)).toBe(canonicalize(dirA));
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
