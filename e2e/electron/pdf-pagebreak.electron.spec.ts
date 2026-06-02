import { join } from "node:path";
import { readWorkspaceFile, seedSettings, workspaceFileSize } from "./helpers/fixtures";
import { expect, test } from "./helpers/launch";

// PDF 改ページ CSS-only redesign (#93) の safety net。
//
// 動的 JS 測定は廃止し、改ページ判定は全て CSS Paged Media に委譲した。renderer 側で
// `<section class="pdf-section-keep">` で wrap した HTML + break-before / break-inside /
// widows / orphans を含む CSS を生成して printToPDF に渡す。ここでは実 IPC 越しに
// 「`break-inside: avoid-page` + section wrap が反映された PDF が生成される」safety net を張る。
test.describe("pdf export with CSS page-break (electron, #93)", () => {
	test.slow();

	test("section wrap + break-inside: avoid-page を含む HTML が PDF として生成される", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		seedSettings(userDataDir, { workspacePath: workspaceDir });
		const { page } = await launch();
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		const outputPath = join(workspaceDir, "section-wrap.pdf");
		const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>e2e</title>
<style>
@page { size: A4; margin: 20mm; }
@media print {
  h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }
  p, li { widows: 3; orphans: 3; break-inside: avoid; page-break-inside: avoid; }
  .pdf-section-keep { break-inside: avoid-page; page-break-inside: avoid; }
  hr.pdf-pagebreak { break-before: page; page-break-before: always; }
  h1 { break-before: page; page-break-before: always; }
}
hr.pdf-pagebreak { border: 0; margin: 0; height: 0; visibility: hidden; }
</style></head><body>
<h1>章1</h1><p>本文1</p>
<section class="pdf-section-keep"><h2>節1</h2><p>本文2</p></section>
<hr class="pdf-pagebreak"/>
<section class="pdf-section-keep"><h2>節2</h2><p>本文3</p></section>
</body></html>`;

		await page.evaluate(({ html, out }) => window.api.exportPdf(html, out), {
			html,
			out: outputPath,
		});

		await expect.poll(() => workspaceFileSize(workspaceDir, "section-wrap.pdf")).toBeGreaterThan(0);
		expect(readWorkspaceFile(workspaceDir, "section-wrap.pdf").startsWith("%PDF")).toBe(true);
	});

	test("hr.pdf-pagebreak 著者マーカーが含まれる HTML も生成成功する", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		seedSettings(userDataDir, { workspacePath: workspaceDir });
		const { page } = await launch();
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		const outputPath = join(workspaceDir, "marker.pdf");
		const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>e2e</title>
<style>@media print { hr.pdf-pagebreak { break-before: page; } }</style></head>
<body><p>a</p><hr class="pdf-pagebreak"/><p>b</p></body></html>`;

		await page.evaluate(({ html, out }) => window.api.exportPdf(html, out), {
			html,
			out: outputPath,
		});

		await expect.poll(() => workspaceFileSize(workspaceDir, "marker.pdf")).toBeGreaterThan(0);
	});
});
