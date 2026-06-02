import { promises as fsp } from "node:fs";
import { join, resolve } from "node:path";
import { _electron as electron, expect as pwExpect } from "@playwright/test";
import { readWorkspaceFile, seedSettings, workspaceFileSize } from "./helpers/fixtures";
import { expect, test } from "./helpers/launch";

// PDF 改ページの hybrid アプローチ (#93) の safety net。
//
// 設計 (要約):
//   1. renderer は markdown→HTML 変換時に `<meta name="scripta-pdf-smart-level">` 等を
//      head に埋め込む。
//   2. main の `pdf:export` IPC は hidden BrowserWindow に HTML を load、fonts.ready
//      + idle 後に executeJavaScript で page-break-script を実行する。
//   3. script が見出しを走査して `style.breakBefore = 'page'` を inline 注入する。
//   4. printToPDF が走り、inline forced break が反映された PDF が出力される。
test.describe("pdf export hybrid section break (#93, electron)", () => {
	test.slow();

	test("meta tag を持つ HTML で実 PDF が生成される", async ({
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
  h1, h2 { break-after: avoid; page-break-after: avoid; }
}
</style></head><body>
<h1>章</h1><p>本文</p>
<h2>節 A</h2><p>本文 A</p>
</body></html>`;

		await page.evaluate(({ html, out }) => window.api.exportPdf(html, out), {
			html,
			out: outputPath,
		});

		await pwExpect.poll(() => workspaceFileSize(workspaceDir, "meta-tags.pdf")).toBeGreaterThan(0);
		expect(readWorkspaceFile(workspaceDir, "meta-tags.pdf").startsWith("%PDF")).toBe(true);
	});

	test("hr.pdf-pagebreak 著者マーカーで複数ページに分かれる (純 CSS 経路、deterministic)", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		seedSettings(userDataDir, { workspacePath: workspaceDir });
		const { page } = await launch();
		await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

		const outputPath = join(workspaceDir, "marker.pdf");
		const html = `<!DOCTYPE html><html><head><style>
@page { size: A4; margin: 20mm; }
@media print { hr.pdf-pagebreak { break-before: page; page-break-before: always; } }
hr.pdf-pagebreak { border: 0; margin: 0; height: 0; visibility: hidden; }
</style></head><body>
<p>page 1</p>
<hr class="pdf-pagebreak"/>
<p>page 2</p>
<hr class="pdf-pagebreak"/>
<p>page 3</p>
</body></html>`;

		await page.evaluate(({ html, out }) => window.api.exportPdf(html, out), {
			html,
			out: outputPath,
		});

		await pwExpect.poll(() => workspaceFileSize(workspaceDir, "marker.pdf")).toBeGreaterThan(0);
		const raw = await fsp.readFile(join(workspaceDir, "marker.pdf"), "binary");
		// 2 マーカー = 3 ページ。`/Type /Page` 出現数で確認 (page 数 proxy としては
		// content-volume と切り離せる deterministic な assertion)。
		const pageMatches = raw.match(/\/Type\s*\/Page\b/g) ?? [];
		expect(pageMatches.length).toBeGreaterThanOrEqual(3);
	});

	test("meta tag を持たない HTML では script が no-op に保たれる (SCRIPTA_PDF_DEBUG で診断 capture)", async ({
		userDataDir,
		workspaceDir,
	}) => {
		// 通常の launch fixture は env を渡せないので、ここでは _electron.launch を直接呼んで
		// `SCRIPTA_PDF_DEBUG=1` を注入し、stderr 経由で script の診断 JSON を捕まえる。
		// この経路だと page count proxy ではなく **script の result そのもの** で「smart-level
		// meta が無い時に no-op か」を直接 assert できる。
		seedSettings(userDataDir, { workspacePath: workspaceDir });
		const stderrLines: string[] = [];
		const app = await electron.launch({
			args: [resolve(process.cwd(), "out/main/index.js"), `--user-data-dir=${userDataDir}`],
			env: { ...process.env, SCRIPTA_PDF_DEBUG: "1" },
		});
		try {
			const stderr = app.process().stderr;
			if (stderr) {
				stderr.on("data", (chunk: Buffer | string) => {
					stderrLines.push(chunk.toString());
				});
			}

			const page = await app.firstWindow();
			await page.waitForLoadState("domcontentloaded");
			await expect(page.getByRole("button", { name: "ワークスペース検索" })).toBeVisible();

			const outputPath = join(workspaceDir, "no-meta.pdf");
			// meta tag を意図的に省略
			const html = `<!DOCTYPE html><html><body>
<h1>章</h1><p>本文</p>
<h2>節 A</h2><p>本文 A</p>
<h2>節 B</h2><p>本文 B</p>
</body></html>`;
			await page.evaluate(({ html, out }) => window.api.exportPdf(html, out), {
				html,
				out: outputPath,
			});

			await pwExpect.poll(() => workspaceFileSize(workspaceDir, "no-meta.pdf")).toBeGreaterThan(0);

			// stderr に script の result JSON が出ているはず
			// 形式: `[scripta:#93] break-before script: { ... } (html N bytes)`
			const joined = stderrLines.join("");
			const m = joined.match(/\[scripta:#93\][^{]*({[^}]+})/);
			expect(m, "diagnostic line should appear in stderr").not.toBeNull();
			const diag = JSON.parse(m?.[1] ?? "{}") as {
				sectionsTotal: number;
				sectionsBroken: number;
				smartLevelUsed: number | null;
			};
			// meta 不在なので script は早期 return: smartLevelUsed=null, sectionsTotal=0
			expect(diag.smartLevelUsed).toBeNull();
			expect(diag.sectionsTotal).toBe(0);
			expect(diag.sectionsBroken).toBe(0);
		} finally {
			await app.close();
		}
	});
});
