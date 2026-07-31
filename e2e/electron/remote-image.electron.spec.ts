import type { Page } from "@playwright/test";
import { markInitialized, seedSettings, tinyPng, writeWorkspaceFiles } from "./helpers/fixtures";
import { expect, test } from "./helpers/launch";

// 「リモート画像を読み込む」設定（loadRemoteImages, 既定 true）の main 側強制を踏む。
//
// 検証は **CSP 層**（`buildCsp` が実 main から実際に送られ、renderer に効いている）に
// 絞る。`securitypolicyviolation` イベントは request がネットワークへ出る前に発火する
// ので、外部疎通なしで決定的に観測できる。
//
// もう一層の webRequest（onBeforeRequest による image cancel）はここでは踏まない:
// cancel された img と DNS 失敗した img は renderer から見て同じ error イベントに
// なり、外部疎通なしでは区別できないため。判定ロジック自体は
// electron/main/utils/remote-image-policy.test.ts の `shouldBlockImageRequest` で
// 網羅し、ここに残るのは onBeforeRequest への配線だけ。
//
// ホスト名は RFC 6761 の予約 TLD `.example` を使う（解決されないので、CI が
// 外部ネットワークを持つかに結果が依存しない）。
const REMOTE_IMAGE_URL = "https://remote.example/pic.png";

// document に CSP violation の記録を仕込む。画像 widget が描画されるのは
// ファイルを開いた後なので、click より前に install する必要がある。
async function recordCspViolations(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as unknown as { __cspViolations?: string[] };
		w.__cspViolations = [];
		document.addEventListener("securitypolicyviolation", (e) => {
			w.__cspViolations?.push(`${e.violatedDirective} ${e.blockedURI}`);
		});
	});
}

async function readCspViolations(page: Page): Promise<string[]> {
	return page.evaluate(
		() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
	);
}

test.describe("remote image policy (electron)", () => {
	test("loadRemoteImages=false で https 画像が CSP で遮断され、ローカル画像は残る", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		writeWorkspaceFiles(workspaceDir, {
			"assets/pic.png": tinyPng(),
			// cursor 行はデコレーション抑止のため、画像は 1 行目以外に置く。
			"note.md": `# Note\n\n![local](assets/pic.png)\n\n![remote](${REMOTE_IMAGE_URL})\n`,
		});
		markInitialized(workspaceDir);
		seedSettings(userDataDir, {
			workspacePath: workspaceDir,
			sidebarVisible: true,
			loadRemoteImages: false,
		});

		const { page } = await launch();
		await recordCspViolations(page);
		await page.getByLabel("note.md file").click();

		// リモート画像は CSP でブロックされ、fallback に化ける。
		await expect(page.locator(".cm-image-fallback")).toHaveCount(1);

		const violations = await readCspViolations(page);
		expect(violations.some((v) => v.startsWith("img-src"))).toBe(true);

		// ローカル画像 (scripta-asset://) は OFF でも従来どおり読み込まれる。
		// ここが壊れるとオフライン用途まで巻き添えになる。
		const localImages = page.locator(".cm-image-widget img");
		await expect(localImages).toHaveCount(1);
		expect(
			await localImages.first().evaluate((el) => (el as HTMLImageElement).naturalWidth),
		).toBeGreaterThan(0);
	});

	test("既定（設定なし）では https 画像が CSP で遮断されない", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		writeWorkspaceFiles(workspaceDir, {
			"note.md": `# Note\n\n![remote](${REMOTE_IMAGE_URL})\n`,
		});
		markInitialized(workspaceDir);
		// loadRemoteImages は seed しない = 未設定。既定 true が効くこと自体の pin。
		seedSettings(userDataDir, { workspacePath: workspaceDir, sidebarVisible: true });

		const { page } = await launch();
		await recordCspViolations(page);
		await page.getByLabel("note.md file").click();

		// 名前解決に失敗して fallback にはなるが、それは CSP による遮断ではない。
		// 「ポリシー上は許可されている」ことを violation の不在で pin する
		// （実際にロードされるかは外部疎通に依存するので assert しない）。
		await expect(page.locator(".cm-image-fallback")).toHaveCount(1);
		expect(await readCspViolations(page)).toEqual([]);
	});
});
