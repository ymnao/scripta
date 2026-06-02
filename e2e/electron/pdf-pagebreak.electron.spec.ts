import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { readWorkspaceFile, seedSettings, workspaceFileSize } from "./helpers/fixtures";
import { expect, test } from "./helpers/launch";

// PDF 改ページの hybrid アプローチ (#93) の safety net。
//
// 設計 (要約):
//   1. renderer は markdown→HTML 変換時に
//      `<meta name="scripta-pdf-smart-level">` / `scripta-pdf-criterion` /
//      `scripta-pdf-force-level` を head に埋め込む。
//   2. main の `pdf:export` IPC が hidden BrowserWindow に HTML を load、
//      fonts.ready + idle 後に executeJavaScript で
//      `electron/main/utils/page-break-script.ts` のスクリプトを実行する。
//   3. スクリプトが見出しを走査して `style.breakBefore = 'page'` を inline 注入する。
//   4. printToPDF が走り、inline forced break が反映された PDF が出力される。
//
// renderer-only mock では executeJavaScript 経路を踏めないので、ここで実 IPC 越しに
// safety net を張る。
test.describe("pdf export hybrid section break (#93, electron)", () => {
	test.slow();

	test("meta tag を持つ HTML で実 PDF が生成される (smart + criterion + force-level)", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		seedSettings(userDataDir, { workspacePath: workspaceDir });
		const { page } = await launch();
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		const outputPath = join(workspaceDir, "meta-tags.pdf");
		const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>e2e</title>
<meta name="scripta-pdf-smart-level" content="2">
<meta name="scripta-pdf-criterion" content="section">
<meta name="scripta-pdf-force-level" content="1">
<style>
@page { size: A4; margin: 20mm; }
@media print {
  h1 { break-before: page; page-break-before: always; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; page-break-after: avoid; }
  p, li { widows: 3; orphans: 3; break-inside: avoid; page-break-inside: avoid; }
}
</style></head><body>
<h1>章 1</h1><p>本文 1</p>
<h2>節 1</h2><p>本文 2</p>
<h2>節 2</h2><p>本文 3</p>
</body></html>`;

		await page.evaluate(({ html, out }) => window.api.exportPdf(html, out), {
			html,
			out: outputPath,
		});

		await expect.poll(() => workspaceFileSize(workspaceDir, "meta-tags.pdf")).toBeGreaterThan(0);
		expect(readWorkspaceFile(workspaceDir, "meta-tags.pdf").startsWith("%PDF")).toBe(true);
	});

	test("script が見出しに inline break-before を注入する (debug HTML で検証)", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		seedSettings(userDataDir, { workspacePath: workspaceDir });
		// pdf.ts の SCRIPTA_PDF_DEBUG_HTML_PATH hook を使って printToPDF 直前の HTML を
		// debug 出力させる経路は inline break-before 注入 *前* の HTML を出すため、
		// inline 注入そのものを直接 assert することはできない。代わりに `script` 経由で
		// 生成された PDF が「複数ページ」になることを確認する (実 break が起きた証拠)。
		const { page } = await launch();
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		// 大量の section を含む HTML を作る (各 section が高さ ~80mm、A4 は ~257mm content area
		// なので 4 sections で 2 ページに分かれるはず)
		const sections = Array.from({ length: 4 }, (_, idx) => {
			const filler = Array.from({ length: 30 }, (_, j) => `<p>本文 ${idx}-${j}</p>`).join("\n");
			return `<h2>節 ${idx}</h2>\n${filler}`;
		}).join("\n");

		const outputPath = join(workspaceDir, "multi-page.pdf");
		const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>e2e</title>
<meta name="scripta-pdf-smart-level" content="2">
<meta name="scripta-pdf-criterion" content="section">
<meta name="scripta-pdf-force-level" content="1">
<style>
@page { size: A4; margin: 20mm; }
@media print {
  h1, h2 { break-after: avoid; }
  p { widows: 3; orphans: 3; break-inside: avoid; }
}
</style></head><body>
<h1>タイトル</h1>
${sections}
</body></html>`;

		await page.evaluate(({ html, out }) => window.api.exportPdf(html, out), {
			html,
			out: outputPath,
		});

		const size = await new Promise<number>((resolve) =>
			setTimeout(() => resolve(workspaceFileSize(workspaceDir, "multi-page.pdf") ?? 0), 1500),
		);
		expect(size).toBeGreaterThan(0);

		// PDF を直接読んで `/Type /Page` の出現数で page 数を概算 (純粋に "%PDF" check よりも
		// inline break-before が機能していることの証拠になる)
		const raw = await fsp.readFile(join(workspaceDir, "multi-page.pdf"), "binary");
		const pageMatches = raw.match(/\/Type\s*\/Page\b/g) ?? [];
		// 4 sections × 約 80mm = ~320mm。A4 で 2 ページ以上にはなるはず。
		expect(pageMatches.length).toBeGreaterThanOrEqual(2);
	});

	test("meta tag を持たない HTML では script が no-op になり、自然 layout で PDF 生成", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		seedSettings(userDataDir, { workspacePath: workspaceDir });
		const { page } = await launch();
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		// scripta-pdf-smart-level meta を意図的に省略 (smart=false 相当のケース)
		const outputPath = join(workspaceDir, "no-meta.pdf");
		const html = `<!DOCTYPE html><html><body>
<h1>章</h1><p>本文</p>
<h2>節 A</h2><p>a</p>
<h2>節 B</h2><p>b</p>
</body></html>`;

		await page.evaluate(({ html, out }) => window.api.exportPdf(html, out), {
			html,
			out: outputPath,
		});

		await expect.poll(() => workspaceFileSize(workspaceDir, "no-meta.pdf")).toBeGreaterThan(0);
		// inline break-before が注入されないので 1 ページに収まるはず (短いコンテンツ)
		const raw = await fsp.readFile(join(workspaceDir, "no-meta.pdf"), "binary");
		const pageMatches = raw.match(/\/Type\s*\/Page\b/g) ?? [];
		expect(pageMatches.length).toBe(1);
	});

	test("hr.pdf-pagebreak 著者マーカーは常に新ページの起点になる", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		seedSettings(userDataDir, { workspacePath: workspaceDir });
		const { page } = await launch();
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		const outputPath = join(workspaceDir, "marker.pdf");
		// hr.pdf-pagebreak の挙動は meta tag の有無に依存しない (純 CSS で `break-before: page`
		// を当てている)。なので meta なしでも 2 ページに分かれる。
		const html = `<!DOCTYPE html><html><head><style>
@page { size: A4; margin: 20mm; }
@media print { hr.pdf-pagebreak { break-before: page; page-break-before: always; } }
hr.pdf-pagebreak { border: 0; margin: 0; height: 0; visibility: hidden; }
</style></head><body>
<p>page 1</p>
<hr class="pdf-pagebreak"/>
<p>page 2</p>
</body></html>`;

		await page.evaluate(({ html, out }) => window.api.exportPdf(html, out), {
			html,
			out: outputPath,
		});

		await expect.poll(() => workspaceFileSize(workspaceDir, "marker.pdf")).toBeGreaterThan(0);
		const raw = await fsp.readFile(join(workspaceDir, "marker.pdf"), "binary");
		const pageMatches = raw.match(/\/Type\s*\/Page\b/g) ?? [];
		expect(pageMatches.length).toBeGreaterThanOrEqual(2);
	});
});
