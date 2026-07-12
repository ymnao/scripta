import { join } from "node:path";
import { markInitialized, seedSettings, tinyPng, writeWorkspaceFiles } from "./helpers/fixtures";
import { expect, test } from "./helpers/launch";

// 領域6: Image rendering（live-preview の画像描画 + 実 asset protocol ロード）。
// 相対パス（activeTabPath 基準で解決）と絶対パスの両方が scripta-asset:// に解決され、
// 実 main の protocol 越しに実際に読み込まれる（fallback にならない）ことを踏む。
// `resolveImageSrc`（src/lib/image-src.ts）の解決結果が実 IPC
// と噛み合うかは mock では検証できない。
//
// 注: wikilink-image（`![[img.png]]`）は現状 live-preview 未実装（images.ts は標準
// markdown `Image` ノードのみ対応）。safety net は既存挙動の固定が目的なので対象外。
test.describe("image rendering (electron)", () => {
	test("相対パス・絶対パスの画像が scripta-asset:// で描画される", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		const absImagePath = join(workspaceDir, "assets/pic.png");
		writeWorkspaceFiles(workspaceDir, {
			"assets/pic.png": tinyPng(),
			// cursor は開いた直後 line 1 にあるため、画像は別行に置いて widget 描画させる
			// （cursor 行はデコレーション抑止: CLAUDE.md Live Preview 規約）。
			"note.md": `# Note\n\n![rel](assets/pic.png)\n\n![abs](${absImagePath})\n`,
		});
		// ファイルツリーを click するため SetupWizardDialog を抑止する。
		markInitialized(workspaceDir);
		seedSettings(userDataDir, { workspacePath: workspaceDir, sidebarVisible: true });

		const { page } = await launch();
		await page.getByLabel("note.md file").click();

		// 2 つの画像 widget が描画される（error 時は img が remove され fallback に化ける）。
		const images = page.locator(".cm-image-widget img");
		await expect(images).toHaveCount(2);

		// 両画像が実際に protocol 越しにロードされている（naturalWidth>0）。
		const widths = await images.evaluateAll((els) =>
			els.map((el) => (el as HTMLImageElement).naturalWidth),
		);
		expect(widths).toHaveLength(2);
		for (const w of widths) {
			expect(w).toBeGreaterThan(0);
		}

		// fallback（読み込み失敗表示）が出ていないこと。
		await expect(page.locator(".cm-image-fallback")).toHaveCount(0);
	});
});
