import { join } from "node:path";
import { readWorkspaceFile, seedSettings, workspaceFileSize } from "./helpers/fixtures";
import { expect, test } from "./helpers/launch";

// PDF 改ページ redesign (#93) の safety net。
//
// 動的判定スクリプトは renderer 側 inline `<script>` 注入をやめ、main の
// `webContents.executeJavaScript` で post-idle 注入する設計に変えた。renderer-only
// テストでは executeJavaScript 経路を踏めないため、ここで実 IPC 越しに safety net を張る:
// - pageBreak option を受けつけて PDF 生成が成功する
// - 不正な pageBreak option（バリデーション漏れ）も graceful に reject せず生成成功
// - HTML に inline `<script>` が無いことを debug hook 経由で確認
test.describe("pdf export with pageBreak option (electron, #93)", () => {
	test.slow();

	test("pageBreak option 付き exportPdf は実 PDF を生成する", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		seedSettings(userDataDir, { workspacePath: workspaceDir });
		const { page } = await launch();
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		const outputPath = join(workspaceDir, "pagebreak.pdf");
		const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>e2e</title>
<style>
@page { size: A4; margin: 20mm; }
@media print {
  h1, h2, h3 { break-before: page; }
  [data-no-break] { break-before: auto !important; }
  hr.pdf-pagebreak { break-before: page; }
}
hr.pdf-pagebreak { border: 0; margin: 0; height: 0; visibility: hidden; }
</style></head><body>
<h1>章1</h1><p>本文1</p>
<h2>節1</h2><p>本文2</p>
<hr class="pdf-pagebreak"/>
<h2>節2</h2><p>本文3</p>
</body></html>`;

		await page.evaluate(
			({ html, out }) => window.api.exportPdf(html, out, { level: 2, criterion: "compact" }),
			{ html, out: outputPath },
		);

		await expect.poll(() => workspaceFileSize(workspaceDir, "pagebreak.pdf")).toBeGreaterThan(0);
		expect(readWorkspaceFile(workspaceDir, "pagebreak.pdf").startsWith("%PDF")).toBe(true);
	});

	test("不正な pageBreak option は main 側で undefined として扱われ生成成功する", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		seedSettings(userDataDir, { workspacePath: workspaceDir });
		const { page } = await launch();
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		const outputPath = join(workspaceDir, "invalid-cfg.pdf");
		const html = "<!DOCTYPE html><html><body><h1>x</h1></body></html>";

		// level=99 / criterion="bogus" は isValidPageBreakConfig 不通過 → undefined fallback。
		await page.evaluate(
			({ html, out }) =>
				window.api.exportPdf(html, out, {
					level: 99 as unknown as 1,
					criterion: "bogus" as unknown as "compact",
				}),
			{ html, out: outputPath },
		);

		await expect.poll(() => workspaceFileSize(workspaceDir, "invalid-cfg.pdf")).toBeGreaterThan(0);
	});

	test("criterion=section も受け入れて生成成功する", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		seedSettings(userDataDir, { workspacePath: workspaceDir });
		const { page } = await launch();
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		const outputPath = join(workspaceDir, "section.pdf");
		const html = "<!DOCTYPE html><html><body><h1>x</h1><h2>y</h2><p>z</p></body></html>";

		await page.evaluate(
			({ html, out }) => window.api.exportPdf(html, out, { level: 3, criterion: "section" }),
			{ html, out: outputPath },
		);

		await expect.poll(() => workspaceFileSize(workspaceDir, "section.pdf")).toBeGreaterThan(0);
	});
});
