import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { markInitialized, seedSettings, writeWorkspaceFiles } from "./helpers/fixtures";

// #394 Phase D safety net: chokidar → L3 InvertedIndex 本配線 → 検索結果の end-to-end。
// SCRIPTA_DARK_ASSERT=1 の dual-run で「candidates 経路 と 全走査 の hit file 集合突合」も
// 併せて確認する (真の superset 破損 or 未解消の watcher-latency 窓があればプロセスが例外で落ちる)。
//
// renderer-only モードでは window.api mock 経由なので L3 が動かない。実 IPC + chokidar + main の
// 統合はここでしか固定できないため、mock でカバーする「UI 契約 (results / truncated 描画)」の
// 反復にせず、以下 3 点を最小限で担保する:
//   1. 初期 index (piggyback / idle fill) が候補経路で正しい結果を返すこと
//   2. 保存で watcher batch が届くと後続検索が新内容を返すこと (invalidate → 再 index / fallback)
//   3. dark assert が throw しない (dual-run 突合が通る) — 真の superset 破損の safety net
test.describe("search L3 candidates end-to-end (electron)", () => {
	test("chokidar watcher → InvertedIndex invalidate → 検索結果が新内容を返す + dark assert 突合が通る", async () => {
		const userDataDir = mkdtempSync(join(tmpdir(), "scripta-e2e-userdata-l3-"));
		const workspaceDir = mkdtempSync(join(tmpdir(), "scripta-e2e-workspace-l3-"));
		try {
			writeWorkspaceFiles(workspaceDir, {
				"alpha.md": "# Alpha\nquickbrownfoxjumps over the lazy dog\n",
				"beta.md": "# Beta\nunrelated content\n",
			});
			markInitialized(workspaceDir);
			seedSettings(userDataDir, { workspacePath: workspaceDir, sidebarVisible: true });

			// dark assert を有効にして起動 (dual-run 実行、突合違反時に main が例外で落ちる)。
			const mainEntry = join(process.cwd(), "out/main/index.js");
			const app = await electron.launch({
				args: [mainEntry, `--user-data-dir=${userDataDir}`],
				env: { ...process.env, SCRIPTA_DARK_ASSERT: "1" },
			});
			try {
				const page = await app.firstWindow();
				await page.waitForLoadState("domcontentloaded");

				// 検索パネルを開く。
				await page.getByRole("button", { name: "ワークスペース検索" }).click();
				const input = page.getByPlaceholder("ファイル内を検索…");

				// (1) 既存語 "quickbrownfoxjumps" が alpha.md にヒットすること。debounce 300ms + walk / index を待つ。
				await input.fill("quickbrownfoxjumps");
				await expect(page.getByText("alpha.md", { exact: false })).toBeVisible({ timeout: 5000 });

				// (2) 新 file を追加して chokidar → L1 invalidate → 検索が新内容を返すこと。
				//     固定 sleep は flaky 源なので「polling で hit を待つ」。
				await input.fill("");
				writeFileSync(
					join(workspaceDir, "gamma.md"),
					"# Gamma\nsupercalifragilisticnovel\n",
					"utf8",
				);
				await input.fill("supercalifragilisticnovel");
				await expect(page.getByText("gamma.md", { exact: false })).toBeVisible({
					timeout: 10_000,
				});

				// (3) 既存 file の書換で語を除去 → 検索から消えること (invalidate → 再 index / fallback の負方向)。
				await input.fill("");
				writeFileSync(join(workspaceDir, "alpha.md"), "# Alpha\n(removed)\n", "utf8");
				await input.fill("quickbrownfoxjumps");
				// 結果なしメッセージが表示されるまで待つ (polling)。
				await expect(page.getByText("結果なし")).toBeVisible({ timeout: 10_000 });

				// (4) dark assert が throw していないことは、ここまでプロセスが生きていることで担保。
				// main プロセスが例外で落ちていれば page.getByText 系が timeout していたはず。
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
			rmSync(workspaceDir, { recursive: true, force: true });
		}
	});
});
