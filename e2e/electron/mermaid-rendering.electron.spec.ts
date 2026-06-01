import { markInitialized, seedSettings, writeWorkspaceFiles } from "./helpers/fixtures";
import { expect, modKey, test } from "./helpers/launch";

// 領域10: Mermaid 描画（live-preview の重量 widget を実 Chromium で描画）。
// renderer-only でも mermaid widget は検証しているが、それは Vite dev server 上の
// Chromium。本 spec は build 成果物（`loadFile` した production renderer）+ 実 main で
// mermaid ライブラリが bundle され、実際に SVG ノードまで描画されることを踏む
// （bundling 漏れ・production minify による初期化失敗等は mock では検出できない）。
// issue #86 シナリオ 4。
test.describe("mermaid rendering (electron)", () => {
	// 実 Chromium での mermaid 初期化 + SVG 描画は重いので timeout 緩和。
	test.slow();

	test("Mermaid ブロックが build 成果物の renderer で実 SVG として描画される", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		writeWorkspaceFiles(workspaceDir, {
			// cursor は開いた直後 line 1 にあるため、mermaid は別行に置いて widget 描画させる
			// （cursor 行はデコレーション抑止: CLAUDE.md Live Preview 規約）。
			"diagram.md": "# Diagram\n\nintro text\n\n```mermaid\ngraph TD\n  A-->B\n```\n\noutro text\n",
		});
		markInitialized(workspaceDir);
		seedSettings(userDataDir, { workspacePath: workspaceDir, sidebarVisible: true });

		const { page } = await launch();
		await page.getByLabel("diagram.md file").click();

		// cursor を 1 行目へ寄せて mermaid ブロックからカーソルを離す。
		await page.locator(".cm-content").click();
		await page.keyboard.press(`${modKey}+Home`);

		// widget と内側 SVG コンテナが描画される。
		const widget = page.locator(".cm-mermaid-widget");
		await expect(widget).toBeVisible({ timeout: 15000 });
		await expect(widget.locator(".cm-mermaid-inner")).toBeVisible({ timeout: 15000 });

		// 実 SVG にノードが描画されている（初期化失敗時は SVG 無し or ノード無し）。
		const info = await widget.evaluate((el) => {
			const svg = el.querySelector("svg");
			const hasNodes =
				svg !== null &&
				(svg.querySelector(".node") !== null || svg.querySelector("foreignObject") !== null);
			return { hasSvg: svg !== null, hasNodes };
		});
		expect(info.hasSvg).toBe(true);
		expect(info.hasNodes).toBe(true);
	});
});
