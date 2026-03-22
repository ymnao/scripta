import { act, renderHook } from "@testing-library/react";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/app", () => ({
	getVersion: vi.fn(),
}));

vi.mock("../lib/commands", () => ({
	checkForUpdate: vi.fn(),
	openExternal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/store", () => ({
	loadLastUpdateCheck: vi.fn(),
	saveLastUpdateCheck: vi.fn().mockResolvedValue(undefined),
}));

const { getVersion } = await import("@tauri-apps/api/app");
const { checkForUpdate, openExternal } = await import("../lib/commands");
const { loadLastUpdateCheck, saveLastUpdateCheck } = await import("../lib/store");
const { useUpdateCheck } = await import("./useUpdateCheck");

const mockedGetVersion = getVersion as Mock;
const mockedCheckForUpdate = checkForUpdate as Mock;
const mockedLoadLastUpdateCheck = loadLastUpdateCheck as Mock;
const mockedSaveLastUpdateCheck = saveLastUpdateCheck as Mock;

const HOUR_MS = 60 * 60 * 1000;

const updateAvailable = {
	hasUpdate: true,
	latestVersion: "1.0.0",
	currentVersion: "0.1.0",
	releaseUrl: "https://github.com/ymnao/scripta/releases/tag/v1.0.0",
};

const noUpdate = {
	hasUpdate: false,
	latestVersion: "0.1.0",
	currentVersion: "0.1.0",
	releaseUrl: "https://github.com/ymnao/scripta/releases/tag/v0.1.0",
};

describe("useUpdateCheck", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedGetVersion.mockResolvedValue("0.1.0");
		mockedLoadLastUpdateCheck.mockResolvedValue(0);
		mockedCheckForUpdate.mockResolvedValue(noUpdate);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("enabled=false のときチェックしない", async () => {
		renderHook(() => useUpdateCheck(false));
		await vi.waitFor(() => {
			expect(mockedLoadLastUpdateCheck).not.toHaveBeenCalled();
			expect(mockedCheckForUpdate).not.toHaveBeenCalled();
		});
	});

	it("24時間以内にチェック済みならスキップする", async () => {
		mockedLoadLastUpdateCheck.mockResolvedValue(Date.now() - 1 * HOUR_MS);

		renderHook(() => useUpdateCheck(true));

		await vi.waitFor(() => {
			expect(mockedLoadLastUpdateCheck).toHaveBeenCalled();
		});
		expect(mockedCheckForUpdate).not.toHaveBeenCalled();
		expect(mockedSaveLastUpdateCheck).not.toHaveBeenCalled();
	});

	it("24時間経過後にチェックを実行する", async () => {
		mockedLoadLastUpdateCheck.mockResolvedValue(Date.now() - 25 * HOUR_MS);
		mockedCheckForUpdate.mockResolvedValue(noUpdate);

		renderHook(() => useUpdateCheck(true));

		await vi.waitFor(() => {
			expect(mockedCheckForUpdate).toHaveBeenCalledWith("0.1.0");
		});
		expect(mockedSaveLastUpdateCheck).toHaveBeenCalled();
	});

	it("更新ありのときダイアログを開く", async () => {
		mockedCheckForUpdate.mockResolvedValue(updateAvailable);

		const { result } = renderHook(() => useUpdateCheck(true));

		await vi.waitFor(() => {
			expect(result.current.dialogOpen).toBe(true);
		});
		expect(result.current.description).toContain("v1.0.0");
		expect(result.current.description).toContain("v0.1.0");
	});

	it("更新なしのときダイアログを開かない", async () => {
		mockedCheckForUpdate.mockResolvedValue(noUpdate);

		const { result } = renderHook(() => useUpdateCheck(true));

		await vi.waitFor(() => {
			expect(mockedSaveLastUpdateCheck).toHaveBeenCalled();
		});
		expect(result.current.dialogOpen).toBe(false);
		expect(result.current.description).toBe("");
	});

	it("ネットワークエラー時はサイレントにスキップしダイアログを開かない", async () => {
		mockedCheckForUpdate.mockRejectedValue(new Error("Network error"));

		const { result } = renderHook(() => useUpdateCheck(true));

		// effect が完了するのを待つ (checkForUpdate が呼ばれた時点で完了)
		await vi.waitFor(() => {
			expect(mockedCheckForUpdate).toHaveBeenCalled();
		});
		expect(result.current.dialogOpen).toBe(false);
		expect(mockedSaveLastUpdateCheck).not.toHaveBeenCalled();
	});

	it("dismissDialog でダイアログを閉じる", async () => {
		mockedCheckForUpdate.mockResolvedValue(updateAvailable);

		const { result } = renderHook(() => useUpdateCheck(true));

		await vi.waitFor(() => {
			expect(result.current.dialogOpen).toBe(true);
		});

		act(() => {
			result.current.dismissDialog();
		});

		expect(result.current.dialogOpen).toBe(false);
	});

	it("openReleasePage でリリースページを開きダイアログを閉じる", async () => {
		mockedCheckForUpdate.mockResolvedValue(updateAvailable);

		const { result } = renderHook(() => useUpdateCheck(true));

		await vi.waitFor(() => {
			expect(result.current.dialogOpen).toBe(true);
		});

		act(() => {
			result.current.openReleasePage();
		});

		expect(openExternal).toHaveBeenCalledWith(updateAvailable.releaseUrl);
		expect(result.current.dialogOpen).toBe(false);
	});

	it("enabled が false→true に遷移するとチェックを実行する", async () => {
		const { result, rerender } = renderHook(({ enabled }) => useUpdateCheck(enabled), {
			initialProps: { enabled: false },
		});

		expect(mockedCheckForUpdate).not.toHaveBeenCalled();

		mockedCheckForUpdate.mockResolvedValue(updateAvailable);
		rerender({ enabled: true });

		await vi.waitFor(() => {
			expect(result.current.dialogOpen).toBe(true);
		});
	});

	it("saveLastUpdateCheck 待ち中にクリーンアップされたらダイアログを開かない", async () => {
		// saveLastUpdateCheck を遅延させてクリーンアップのタイミングを作る
		let resolveSave!: () => void;
		mockedSaveLastUpdateCheck.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveSave = resolve;
			}),
		);
		mockedCheckForUpdate.mockResolvedValue(updateAvailable);

		const { result, rerender } = renderHook(({ enabled }) => useUpdateCheck(enabled), {
			initialProps: { enabled: true },
		});

		// checkForUpdate が呼ばれるまで待つ (saveLastUpdateCheck で止まる)
		await vi.waitFor(() => {
			expect(mockedSaveLastUpdateCheck).toHaveBeenCalled();
		});

		// クリーンアップを発火 (enabled を false に)
		rerender({ enabled: false });

		// 保存を完了させる
		resolveSave();
		await vi.waitFor(() => {});

		// cancelled が true なのでダイアログは開かない
		expect(result.current.dialogOpen).toBe(false);
	});
});
