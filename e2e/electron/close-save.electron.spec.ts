import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import {
	markInitialized,
	readWorkspaceFile,
	seedSettings,
	writeWorkspaceFiles,
} from "./helpers/fixtures";
import { expect, modKey, test } from "./helpers/launch";

// 閉じる前の一括保存 (#727)。main が close を止めて renderer に保存させ、ack を見て
// 閉じるかを決める経路は、mock の window.api では main ごと差し替わるので踏めない。
// autosave を設定上の最大 (10 秒) にしたうえで、close が renderer の ack true で進み
// guard の timeout (同じく 10 秒) で閉じたのではないことを main の stderr で確かめる。
// 待ち時間は xvfb 上の遅さに合わせて長く取っているので、時間では経路を区別できない。
const AUTO_SAVE_DELAY_MS = 10_000;

async function typeUnsavedEdit(page: Page): Promise<void> {
	await page.getByLabel("note.md file").click();
	await expect(page.locator(".cm-content")).toContainText("Note");
	await page.locator(".cm-content").click();
	await page.keyboard.press("End");
	await page.keyboard.type(" typed");
	await expect(page.getByText("未保存")).toBeVisible();
}

// listener を張り終えてからキーを押す。evaluate を await せずに押すと、張る前に ack が
// 届きうる。guard の ack listener は起動時に先に登録されているので、この listener が
// 呼ばれた時点で guard は close を見送るかを決め終えている。
// 閉じるとアプリが終了しうる (Linux の window-all-closed) ので、ack は evaluate の戻り値
// ではなく main の stderr に書かせて読む。
async function logCloseAcks(app: ElectronApplication): Promise<void> {
	await app.evaluate(({ ipcMain }) => {
		ipcMain.on("window:close-requested-ack", (_event, _requestId, ok) => {
			console.error(`[e2e-close-ack] ${String(ok)}`);
		});
	});
}

async function expectClosedByAck(stderr: string[]): Promise<void> {
	await expect.poll(() => stderr.join("")).toContain("[e2e-close-ack] true");
	expect(stderr.join("")).not.toContain("[close-guard]");
}

// 保存に失敗すると main が「保存せずに閉じるか」を native dialog で尋ねる。xvfb 上で
// 押せないので、決めた答えを返す stub に差し替え、呼ばれた回数を main 側に数えさせる。
async function stubDiscardDialog(app: ElectronApplication, response: 0 | 1): Promise<void> {
	await app.evaluate(({ dialog }, answer) => {
		const store = globalThis as { discardAsked?: number };
		store.discardAsked = 0;
		dialog.showMessageBox = (async () => {
			store.discardAsked = (store.discardAsked ?? 0) + 1;
			return { response: answer, checkboxChecked: false };
		}) as typeof dialog.showMessageBox;
	}, response);
}

async function discardAskedCount(app: ElectronApplication): Promise<number> {
	return app.evaluate(() => (globalThis as { discardAsked?: number }).discardAsked ?? 0);
}

async function pressCloseAndReadAck(app: ElectronApplication, page: Page): Promise<unknown> {
	await app.evaluate(({ ipcMain }) => {
		(globalThis as { closeAck?: Promise<unknown> }).closeAck = new Promise((resolve) => {
			ipcMain.once("window:close-requested-ack", (_event, _requestId, ok) => {
				resolve(ok);
			});
		});
	});
	await page.keyboard.press(`${modKey}+Shift+w`);
	return app.evaluate(() => (globalThis as { closeAck?: Promise<unknown> }).closeAck);
}

test.describe("save before close (electron)", () => {
	test.beforeEach(({ userDataDir, workspaceDir }) => {
		writeWorkspaceFiles(workspaceDir, { "note.md": "# Note" });
		markInitialized(workspaceDir);
		seedSettings(userDataDir, {
			workspacePath: workspaceDir,
			sidebarVisible: true,
			autoSaveDelay: AUTO_SAVE_DELAY_MS,
		});
	});

	// 保存失敗の test が途中で落ちても、teardown の app.close() が同じ保存を通れるように戻す。
	test.afterEach(({ workspaceDir }) => {
		const file = join(workspaceDir, "note.md");
		if (existsSync(file)) chmodSync(file, 0o644);
	});

	test("打った直後にウィンドウを閉じても、閉じる前に disk へ書き込む", async ({
		launch,
		workspaceDir,
	}) => {
		test.setTimeout(60_000);
		const { app, page, stderr } = await launch();
		await typeUnsavedEdit(page);
		await logCloseAcks(app);

		const closed = page.waitForEvent("close", { timeout: 30_000 });
		await page.keyboard.press(`${modKey}+Shift+w`);
		await closed;

		await expectClosedByAck(stderr);
		expect(readWorkspaceFile(workspaceDir, "note.md")).toBe("# Note typed\n");
	});

	test("打った直後に quit しても、保存してから終了する", async ({ launch, workspaceDir }) => {
		test.setTimeout(60_000);
		const { app, page, stderr } = await launch();
		await typeUnsavedEdit(page);
		await logCloseAcks(app);
		// CI の Linux では最後のウィンドウが閉じると window-all-closed で quit するので、
		// quit を呼び直さずにウィンドウだけ閉じる実装でも終了してしまう。macOS と同じく
		// ウィンドウが無くなっても残る状態にして、quit が最後まで進むことを見る。
		await app.evaluate(({ app: electronApp }) => {
			electronApp.removeAllListeners("window-all-closed");
			electronApp.on("window-all-closed", () => {});
		});

		const exited = app.waitForEvent("close", { timeout: 30_000 });
		await app.evaluate(({ app: electronApp }) => {
			electronApp.quit();
		});
		await exited;

		await expectClosedByAck(stderr);
		expect(readWorkspaceFile(workspaceDir, "note.md")).toBe("# Note typed\n");
	});

	test("保存に失敗したらウィンドウを閉じない", async ({ launch, workspaceDir }) => {
		test.skip(process.platform === "win32", "chmod で書き込みを拒否できない");
		const { app, page } = await launch();
		await typeUnsavedEdit(page);
		await stubDiscardDialog(app, 0);
		chmodSync(join(workspaceDir, "note.md"), 0o444);

		expect(await pressCloseAndReadAck(app, page)).toBe(false);
		await expect(page.getByText("保存失敗")).toBeVisible();
		// 確認が決着するまでの close は無視されるので、キャンセルが届いてから閉じ直す。
		await expect.poll(() => discardAskedCount(app)).toBe(1);
		// 1 回目の ack の直後はウィンドウが閉じかけでもまだ残って見える。もう一度閉じて
		// 改めて要求が届き、また拒否されることで、1 回目で閉じなかったことを確かめる。
		expect(await pressCloseAndReadAck(app, page)).toBe(false);
		expect(page.isClosed()).toBe(false);
		expect(readWorkspaceFile(workspaceDir, "note.md")).toBe("# Note");
	});

	test("保存に失敗しても、保存せずに閉じるを選べば閉じる", async ({ launch, workspaceDir }) => {
		test.skip(process.platform === "win32", "chmod で書き込みを拒否できない");
		test.setTimeout(60_000);
		const { app, page } = await launch();
		await typeUnsavedEdit(page);
		await stubDiscardDialog(app, 1);
		chmodSync(join(workspaceDir, "note.md"), 0o444);

		const closed = page.waitForEvent("close", { timeout: 30_000 });
		expect(await pressCloseAndReadAck(app, page)).toBe(false);
		await closed;

		expect(readWorkspaceFile(workspaceDir, "note.md")).toBe("# Note");
	});
});
