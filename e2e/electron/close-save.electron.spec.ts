import { chmodSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
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

	test("打った直後にウィンドウを閉じても、閉じる前に disk へ書き込む", async ({
		launch,
		workspaceDir,
	}) => {
		const { page } = await launch();
		await typeUnsavedEdit(page);

		const closed = page.waitForEvent("close", { timeout: 5000 });
		await page.keyboard.press(`${modKey}+Shift+w`);
		await closed;

		expect(readWorkspaceFile(workspaceDir, "note.md")).toBe("# Note typed\n");
	});

	test("打った直後に quit しても、保存してから終了する", async ({ launch, workspaceDir }) => {
		const { app, page } = await launch();
		await typeUnsavedEdit(page);

		const exited = app.waitForEvent("close", { timeout: 5000 });
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

		const file = join(workspaceDir, "note.md");
		chmodSync(file, 0o444);
		try {
			// guard の ack listener は起動時に先に登録されているので、この listener が
			// 呼ばれた時点で guard は close を見送るかを決め終えている。
			// listener を張り終えてからキーを押す。evaluate を await せずに押すと、張る前に
			// ack が届きうる。
			await app.evaluate(({ ipcMain }) => {
				(globalThis as { closeAck?: Promise<unknown> }).closeAck = new Promise((resolve) => {
					ipcMain.once("window:close-requested-ack", (_event, _requestId, ok) => {
						resolve(ok);
					});
				});
			});
			await page.keyboard.press(`${modKey}+Shift+w`);
			expect(
				await app.evaluate(() => (globalThis as { closeAck?: Promise<unknown> }).closeAck),
			).toBe(false);
			await expect(page.getByText("保存失敗")).toBeVisible();
			expect(page.isClosed()).toBe(false);
			expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(
				1,
			);
			expect(readWorkspaceFile(workspaceDir, "note.md")).toBe("# Note");
		} finally {
			// teardown の app.close() も同じ保存を通るので、書けるように戻す。
			chmodSync(file, 0o644);
		}
	});
});
