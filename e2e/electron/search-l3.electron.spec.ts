import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, type Page, test } from "@playwright/test";
import { markInitialized, seedSettings, writeWorkspaceFiles } from "./helpers/fixtures";

// #394 Phase D safety net: chokidar → L3 InvertedIndex 本配線 → 検索結果の end-to-end。
// SCRIPTA_DARK_ASSERT=1 の dual-run で「candidates 経路 と 全走査 の hit file 集合突合」も
// 併せて確認する (真の superset 破損時は main が例外を throw、IPC の reject に化けて
// SearchPanel の catch で「結果なし」に落ちる)。
//
// renderer-only モードでは window.api mock 経由なので L3 が動かない。実 IPC + chokidar + main の
// 統合はここでしか固定できないため、mock でカバーする「UI 契約 (results / truncated 描画)」の
// 反復にせず、以下 3 点を最小限で担保する:
//   1. 初期 index (piggyback / idle fill) が候補経路で正しい結果を返すこと
//   2. 保存で watcher batch が届くと後続検索が新内容を返すこと (invalidate → 再 index / fallback)
//   3. dark assert が throw しない (dual-run 突合が通る) — 真の superset 破損の safety net

// SearchPanel は query 変更をトリガに検索する (fs-change では自動再検索しない)。
// watcher batch は 500ms deadline なので、fs 変更 → 単発 fill だと batch 反映前に 1 度だけ検索が
// 走り stale 結果で終わる。ここでは毎 iteration で「clear → target query 再入力」を行い debounce を
// 発火させ、batch 反映後の再検索を確実に踏む (Fable round 2 Critical fix)。
// SearchPanel useEffect は query 変更で cleanup + 新 timer 開始のため、直後の fill(query) で
// timer が reset され、fill(query) から 300ms 後に IPC が飛ぶ。
async function pollSearchUntil(
	page: Page,
	input: ReturnType<Page["getByPlaceholder"]>,
	query: string,
	predicate: () => Promise<boolean>,
	timeoutMs = 15_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		// 空 fill → target fill で必ず新しい debounce timer を仕込む (同じ query の re-fill は
		// state 不変で effect が再走しないため、間に空を挟む)。
		await input.fill("");
		await input.fill(query);
		// debounce 300ms + IPC + 結果反映の余地を確保 (batch 500ms 以上待つと 1 回あたり長く
		// なりすぎるため、iteration を短くして最終的な待機時間で吸収する)。
		await page.waitForTimeout(500);
		if (await predicate()) return;
	}
	throw new Error(`pollSearchUntil timed out after ${timeoutMs}ms (query=${query})`);
}

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

			// dark assert を有効にして起動 (dual-run 実行、突合違反時に main が例外を throw)。
			// main の stderr / console.error に `[dark-assert]` warn が乗る (dev-monitor safety net)。
			const mainEntry = join(process.cwd(), "out/main/index.js");
			const app = await electron.launch({
				args: [mainEntry, `--user-data-dir=${userDataDir}`],
				env: { ...process.env, SCRIPTA_DARK_ASSERT: "1" },
			});
			try {
				// main process の stderr を監視 (dark assert throw の Error stack や
				// runDarkAssert の warn がここに載る)。process().stderr / stdout を Buffer 化。
				const mainStderr: string[] = [];
				const stderrStream = app.process().stderr;
				if (stderrStream) {
					stderrStream.on("data", (chunk: Buffer) => {
						mainStderr.push(chunk.toString("utf8"));
					});
				}

				const page = await app.firstWindow();
				await page.waitForLoadState("domcontentloaded");
				// renderer 側 unhandled error / console.error を集める。SearchPanel の catch で
				// 化けた rejection は console.error に出るのでこちらで捕捉する
				// (Fable round 2 W4: pageerror だけでは SearchPanel の catch を検出できない)。
				const pageErrors: string[] = [];
				const consoleErrors: string[] = [];
				page.on("pageerror", (e) => pageErrors.push(String(e)));
				page.on("console", (msg) => {
					if (msg.type() === "error") consoleErrors.push(msg.text());
				});

				// 検索パネルを開く。
				await page.getByRole("button", { name: "ワークスペース検索" }).click();
				const input = page.getByPlaceholder("ファイル内を検索…");

				// (1) 既存語 "quickbrownfoxjumps" が alpha.md にヒットすること。
				//     debounce 300ms + walk / index を待つ。初期状態は L1 populate 前なので単発 fill で OK。
				await input.fill("quickbrownfoxjumps");
				await expect(page.getByText("alpha.md", { exact: false })).toBeVisible({ timeout: 5000 });

				// (2) 新 file を追加して chokidar → L1 invalidate → 検索が新内容を返すこと。
				//     SearchPanel は fs-change で自動再検索しないため、toggle polling で
				//     watcher batch 反映後の再検索を確実に踏む。
				writeFileSync(
					join(workspaceDir, "gamma.md"),
					"# Gamma\nsupercalifragilisticnovel\n",
					"utf8",
				);
				await pollSearchUntil(page, input, "supercalifragilisticnovel", async () => {
					return page.getByText("gamma.md", { exact: false }).isVisible();
				});

				// (3) 既存 file の書換で語を除去 → 検索から消えること (invalidate → 再 index / fallback の負方向)。
				writeFileSync(join(workspaceDir, "alpha.md"), "# Alpha\n(removed)\n", "utf8");
				await pollSearchUntil(page, input, "quickbrownfoxjumps", async () => {
					// 「結果なし」が表示されている & alpha.md が結果に無いこと。
					return page.getByText("結果なし").isVisible();
				});

				// (4) dark assert throw の副作用検出用の post-check。
				//     SearchPanel の catch は throw を「結果なし」に置換するため step (3) 単独では
				//     assert 違反を green で通してしまう。ここでヒットする正方向 query で再検索し、
				//     violation なら「結果なし」が返る (throw から SearchPanel が rescue) ことを利用。
				await pollSearchUntil(page, input, "supercalifragilisticnovel", async () => {
					return page.getByText("gamma.md", { exact: false }).isVisible();
				});

				// unhandled error / console.error / main stderr の `[dark-assert]` 系メッセージが
				// 0 件であることを確認。dark assert throw の Error stack や runDarkAssert warn を検出。
				expect(pageErrors).toEqual([]);
				const darkAssertMessages = [
					...consoleErrors.filter(
						(s) => s.includes("dark-assert") || s.includes("InvertedIndex superset invariant"),
					),
					...mainStderr.filter(
						(s) => s.includes("dark-assert") || s.includes("InvertedIndex superset invariant"),
					),
				];
				expect(darkAssertMessages).toEqual([]);
			} finally {
				await app.close();
			}
		} finally {
			rmSync(userDataDir, { recursive: true, force: true });
			rmSync(workspaceDir, { recursive: true, force: true });
		}
	});
});
