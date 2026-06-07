// @vitest-environment node
import type {
	BrowserWindow as ElectronBrowserWindow,
	IpcMainInvokeEvent,
	OpenDialogReturnValue,
	SaveDialogReturnValue,
} from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SaveDialogOptions } from "../../preload/api";

vi.mock("electron", () => ({
	BrowserWindow: {
		fromWebContents: vi.fn(),
		getFocusedWindow: vi.fn(),
		getAllWindows: vi.fn(() => []),
	},
	dialog: {
		showOpenDialog: vi.fn(),
		showSaveDialog: vi.fn(),
	},
	ipcMain: { handle: vi.fn() },
}));

vi.mock("./workspace", () => ({
	approveWorkspacePath: vi.fn(),
}));

vi.mock("../utils/path-guard", () => ({
	registerTransientWritePath: vi.fn(),
}));

import { BrowserWindow, dialog, ipcMain } from "electron";
import { registerTransientWritePath } from "../utils/path-guard";
import { registerDialogIpc } from "./dialog";
import { approveWorkspacePath } from "./workspace";

type OpenDirectoryHandler = (event: IpcMainInvokeEvent) => Promise<string | null>;
type SaveHandler = (event: IpcMainInvokeEvent, opts: SaveDialogOptions) => Promise<string | null>;

const captureHandler = <H>(channel: string): H => {
	registerDialogIpc();
	const calls = vi.mocked(ipcMain.handle).mock.calls;
	const entry = calls.find(([ch]) => ch === channel);
	if (!entry) throw new Error(`${channel} was not registered`);
	return entry[1] as unknown as H;
};

const fakeOwner = (tag: string): ElectronBrowserWindow =>
	({ __tag: tag }) as unknown as ElectronBrowserWindow;

const fakeEvent = (id: number): IpcMainInvokeEvent =>
	({ sender: { id } }) as unknown as IpcMainInvokeEvent;

const mockOpen = (value: OpenDialogReturnValue): void => {
	vi.mocked(dialog.showOpenDialog).mockResolvedValue(value);
};
const mockSave = (value: SaveDialogReturnValue): void => {
	vi.mocked(dialog.showSaveDialog).mockResolvedValue(value);
};

beforeEach(() => {
	vi.mocked(ipcMain.handle).mockReset();
	vi.mocked(BrowserWindow.fromWebContents).mockReset();
	vi.mocked(BrowserWindow.getFocusedWindow).mockReset();
	vi.mocked(BrowserWindow.getAllWindows).mockReset();
	vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
	vi.mocked(dialog.showOpenDialog).mockReset();
	vi.mocked(dialog.showSaveDialog).mockReset();
	vi.mocked(approveWorkspacePath).mockReset();
	vi.mocked(registerTransientWritePath).mockReset();
});

describe("dialog:open-directory", () => {
	it("returns null and does not approve when canceled", async () => {
		vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(fakeOwner("sender"));
		mockOpen({ canceled: true, filePaths: [] });

		const handler = captureHandler<OpenDirectoryHandler>("dialog:open-directory");
		const result = await handler(fakeEvent(1));

		expect(result).toBeNull();
		expect(vi.mocked(approveWorkspacePath)).not.toHaveBeenCalled();
	});

	it("approves selected path and returns it (window-scoped)", async () => {
		vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(fakeOwner("sender"));
		mockOpen({ canceled: false, filePaths: ["/picked/workspace"] });

		const handler = captureHandler<OpenDirectoryHandler>("dialog:open-directory");
		const result = await handler(fakeEvent(1));

		expect(result).toBe("/picked/workspace");
		expect(vi.mocked(approveWorkspacePath)).toHaveBeenCalledWith(1, "/picked/workspace");
		expect(vi.mocked(approveWorkspacePath)).toHaveBeenCalledTimes(1);
	});
});

describe("dialog:save", () => {
	it("returns null and does not register transient write when canceled", async () => {
		vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(fakeOwner("sender"));
		mockSave({ canceled: true, filePath: "" });

		const handler = captureHandler<SaveHandler>("dialog:save");
		const result = await handler(fakeEvent(5), { defaultPath: "x.html" });

		expect(result).toBeNull();
		expect(vi.mocked(registerTransientWritePath)).not.toHaveBeenCalled();
	});

	it("forwards opts and owner to showSaveDialog, registers transient write, and returns the chosen path", async () => {
		const owner = fakeOwner("sender");
		vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(owner);
		mockSave({ canceled: false, filePath: "/Users/me/Desktop/note.html" });

		const opts: SaveDialogOptions = {
			defaultPath: "note.html",
			filters: [{ name: "HTML", extensions: ["html"] }],
		};
		const handler = captureHandler<SaveHandler>("dialog:save");
		const result = await handler(fakeEvent(7), opts);

		expect(result).toBe("/Users/me/Desktop/note.html");
		// HTML エクスポート等は defaultPath / filters が落ちると初期ファイル名や
		// 拡張子フィルタが壊れる（regression 検出ポイント）
		expect(vi.mocked(dialog.showSaveDialog)).toHaveBeenCalledWith(owner, opts);
		expect(vi.mocked(registerTransientWritePath)).toHaveBeenCalledWith(
			7,
			"/Users/me/Desktop/note.html",
		);
		expect(vi.mocked(registerTransientWritePath)).toHaveBeenCalledTimes(1);
	});

	// showSaveDialog 専用 wrapper の owner 解決経路。フォールバックの 4 段は
	// dialog:open-directory 側で網羅済みだが、null owner の overload 切り替えは
	// dialog.ts:34 の独立 wrapper にあるため、save 側でも 1 引数版が呼ばれることを
	// 別途確認しないと save の wrapper だけ壊れた regression を見落とす。
	it("calls showSaveDialog without an owner argument when no windows exist", async () => {
		vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
		vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null);
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
		mockSave({ canceled: true, filePath: "" });

		const opts: SaveDialogOptions = { defaultPath: "x.html" };
		const handler = captureHandler<SaveHandler>("dialog:save");
		await handler(fakeEvent(7), opts);

		const calls = vi.mocked(dialog.showSaveDialog).mock.calls;
		expect(calls).toHaveLength(1);
		expect(calls[0]).toHaveLength(1);
		expect(calls[0][0]).toEqual(opts);
	});
});

// `getOwnerWindow` は private なので、IPC ハンドラ越しに dialog.showOpenDialog の
// 第 1 引数として渡される owner を観測することで分岐網羅を確認する。
describe("getOwnerWindow フォールバック順", () => {
	it("uses BrowserWindow.fromWebContents(event.sender) when present", async () => {
		const owner = fakeOwner("from-web-contents");
		vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(owner);
		mockOpen({ canceled: true, filePaths: [] });

		const event = fakeEvent(1);
		const handler = captureHandler<OpenDirectoryHandler>("dialog:open-directory");
		await handler(event);

		expect(vi.mocked(BrowserWindow.fromWebContents)).toHaveBeenCalledWith(event.sender);
		expect(vi.mocked(BrowserWindow.getFocusedWindow)).not.toHaveBeenCalled();
		expect(vi.mocked(BrowserWindow.getAllWindows)).not.toHaveBeenCalled();
		expect(vi.mocked(dialog.showOpenDialog)).toHaveBeenCalledWith(owner, {
			properties: ["openDirectory"],
		});
	});

	it("falls back to getFocusedWindow when fromWebContents returns null", async () => {
		const focused = fakeOwner("focused");
		vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
		vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(focused);
		mockOpen({ canceled: true, filePaths: [] });

		const handler = captureHandler<OpenDirectoryHandler>("dialog:open-directory");
		await handler(fakeEvent(1));

		expect(vi.mocked(BrowserWindow.getAllWindows)).not.toHaveBeenCalled();
		expect(vi.mocked(dialog.showOpenDialog)).toHaveBeenCalledWith(focused, {
			properties: ["openDirectory"],
		});
	});

	it("falls back to getAllWindows()[0] when fromWebContents and getFocusedWindow are null", async () => {
		const first = fakeOwner("first");
		vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
		vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null);
		// 末尾要素を含めて [0] が選ばれることを保証する（length 1 の配列だと
		// 「先頭」と「最後」の区別が付かないため、配列長 2 で先頭採用を確認）
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([first, fakeOwner("ignored-tail")]);
		mockOpen({ canceled: true, filePaths: [] });

		const handler = captureHandler<OpenDirectoryHandler>("dialog:open-directory");
		await handler(fakeEvent(1));

		expect(vi.mocked(dialog.showOpenDialog)).toHaveBeenCalledWith(first, {
			properties: ["openDirectory"],
		});
	});

	it("calls showOpenDialog without an owner argument when no windows exist", async () => {
		vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);
		vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValue(null);
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);
		mockOpen({ canceled: true, filePaths: [] });

		const handler = captureHandler<OpenDirectoryHandler>("dialog:open-directory");
		await handler(fakeEvent(1));

		// owner に null を渡すと Electron の overload 解決で TypeError になるため、
		// dialog.ts は 2 引数版ではなく 1 引数版（opts only）で呼ぶ実装になっている
		const calls = vi.mocked(dialog.showOpenDialog).mock.calls;
		expect(calls).toHaveLength(1);
		expect(calls[0]).toHaveLength(1);
		expect(calls[0][0]).toEqual({ properties: ["openDirectory"] });
	});
});
