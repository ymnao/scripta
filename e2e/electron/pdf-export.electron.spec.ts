import { join } from "node:path";
import {
	readWorkspaceFile,
	seedSettings,
	workspaceFileSize,
	writeWorkspaceFiles,
} from "./helpers/fixtures";
import { expect, test } from "./helpers/launch";

// 領域11: PDF エクスポート（`webContents.printToPDF` + write path-guard + atomic write）。
// mock では `exportPdf` の呼び出し有無を記録するだけで、実 main の隠し BrowserWindow
// 生成・printToPDF・path-guard 検証・write-file-atomic は踏めない。ここでは実 IPC
// 越しに「PDF が実ファイルとしてディスクに生成される」ことを safety net 化する
// （issue #86 シナリオ 5）。
//
// 注: ExportDialog の UI は `isPdfSupported`（src/lib/platform.ts の IS_MAC || IS_WINDOWS）
// で PDF ボタンを無効化する **product レベル**の制約で、capability（printToPDF 自体）は
// 全 OS で動く。UI ゲートは renderer-only `export.spec.ts` がカバー済みなので、本 spec は
// IPC を直接呼んで capability 境界（Linux CI 含む全 OS で実行可能）を検証する。
test.describe("pdf export (electron)", () => {
	// printToPDF（隠し window load + font ready + 描画）は重いので timeout 緩和。
	test.slow();

	test("workspace 内パスへ printToPDF で実 PDF ファイルが生成される", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		writeWorkspaceFiles(workspaceDir, { "note.md": "# Note" });
		seedSettings(userDataDir, { workspacePath: workspaceDir });

		const { page } = await launch();
		// workspace 復元 = main window が write-allowed root を register 済み
		// （これがないと workspace 内であっても assertWritePathAllowed が通らない）。
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		const outputPath = join(workspaceDir, "export.pdf");
		const html =
			'<!DOCTYPE html><html><head><meta charset="utf-8"><title>e2e</title></head><body><h1>PDF e2e</h1><p>printToPDF safety net.</p></body></html>';

		// 実 main の pdf:export を直接呼ぶ。reject されず resolve すれば path-guard を
		// 通過し printToPDF が成功している。
		await page.evaluate(({ html, out }) => window.api.exportPdf(html, out), {
			html,
			out: outputPath,
		});

		// ディスクに非空の PDF が生成され、PDF magic header を持つ。
		await expect.poll(() => workspaceFileSize(workspaceDir, "export.pdf")).toBeGreaterThan(0);
		// %PDF ヘッダは ASCII なので utf8 read でも先頭は保持される。
		expect(readWorkspaceFile(workspaceDir, "export.pdf").startsWith("%PDF")).toBe(true);
	});

	test("workspace 外パスへの printToPDF は write path-guard で拒否される", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		writeWorkspaceFiles(workspaceDir, { "note.md": "# Note" });
		seedSettings(userDataDir, { workspacePath: workspaceDir });

		const { page } = await launch();
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		// userData は allowed root 外。transient capability も無いので拒否される。
		const outsidePath = join(userDataDir, "escape.pdf");
		const html = "<!DOCTYPE html><html><body><h1>denied</h1></body></html>";

		const rejected = await page.evaluate(
			({ html, out }) =>
				window.api
					.exportPdf(html, out)
					.then(() => false)
					.catch(() => true),
			{ html, out: outsidePath },
		);
		expect(rejected).toBe(true);
		expect(workspaceFileSize(userDataDir, "escape.pdf")).toBeNull();
	});
});
