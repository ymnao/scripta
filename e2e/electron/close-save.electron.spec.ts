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
// autosave を設定上の最大 (10 秒) にして、disk に残った内容が autosave ではなく
// 閉じる前の保存から来たことを保証する。
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
		const { page } = await launch();
		await typeUnsavedEdit(page);

		const closed = page.waitForEvent("close", { timeout: 30_000 });
		await page.keyboard.press(`${modKey}+Shift+w`);
		await closed;

		expect(readWorkspaceFile(workspaceDir, "note.md")).toBe("# Note typed\n");
	});

	test("打った直後に quit しても、保存してから終了する", async ({ launch, workspaceDir }) => {
		test.setTimeout(60_000);
		const { app, page } = await launch();
		await typeUnsavedEdit(page);
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

		expect(readWorkspaceFile(workspaceDir, "note.md")).toBe("# Note typed\n");
	});

	test("保存に失敗したらウィンドウを閉じない", async ({ launch, workspaceDir }) => {
		test.skip(process.platform === "win32", "chmod で書き込みを拒否できない");
		const { app, page } = await launch();
		await typeUnsavedEdit(page);
		chmodSync(join(workspaceDir, "note.md"), 0o444);

		expect(await pressCloseAndReadAck(app, page)).toBe(false);
		await expect(page.getByText("保存失敗")).toBeVisible();
		// 1 回目の ack の直後はウィンドウが閉じかけでもまだ残って見える。もう一度閉じて
		// 改めて要求が届き、また拒否されることで、1 回目で閉じなかったことを確かめる。
		expect(await pressCloseAndReadAck(app, page)).toBe(false);
		expect(page.isClosed()).toBe(false);
		expect(readWorkspaceFile(workspaceDir, "note.md")).toBe("# Note");
	});
});
