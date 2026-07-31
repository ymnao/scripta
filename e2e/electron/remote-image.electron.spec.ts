import type { Page } from "@playwright/test";
import { markInitialized, seedSettings, tinyPng, writeWorkspaceFiles } from "./helpers/fixtures";
import { expect, test } from "./helpers/launch";

// 「リモート画像を読み込む」設定（loadRemoteImages, 既定 true）の main 側強制を踏む。
// 2 層それぞれに 1 本ずつ当てる:
//
//   - CSP 層 — `securitypolicyviolation` イベントで観測する。request が
//     ネットワークへ出る前に発火するので外部疎通なしで決定的。
//   - webRequest 層（即時性を担う側）— 起動後にトグルを OFF にしてから **別の**
//     リモート画像を開き、`requestfailed` の errorText が
//     `net::ERR_BLOCKED_BY_CLIENT`（webRequest による cancel）であることを見る。
//     reload していないので当該 document の CSP はまだ `https:` を許可したまま
//     であり、遮断できたのは webRequest 層だけだと言い切れる。
//
// ホスト名は RFC 6761 の予約 TLD `.example` を使う（解決されないので、CI が
// 外部ネットワークを持つかに結果が依存しない）。DNS 失敗は
// `net::ERR_NAME_NOT_RESOLVED` で cancel と区別が付く。
const REMOTE_IMAGE_URL = "https://remote.example/pic.png";
const BLOCKED_BY_CLIENT = "net::ERR_BLOCKED_BY_CLIENT";

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

// renderer から実 IPC で設定を書き換える（UI を操作するより経路が短く、
// main 側 store cache が即座に更新されることまで含めて実 IPC を通る）。
async function setLoadRemoteImages(page: Page, value: boolean): Promise<void> {
	await page.evaluate(async (v) => {
		const { api } = window as unknown as {
			api: {
				settingsSet: (key: string, value: unknown) => Promise<void>;
				settingsSave: () => Promise<void>;
			};
		};
		await api.settingsSet("loadRemoteImages", v);
		await api.settingsSave();
	}, value);
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
		await expect.poll(() => readCspViolations(page)).toEqual([]);
	});

	test("起動後に OFF へ切り替えると reload なしで webRequest が遮断する", async ({
		launch,
		userDataDir,
		workspaceDir,
	}) => {
		// 2 ファイルに **別々の** URL を置く。同じ URL だと ImageWidget.eq() と
		// Chromium の memory cache により 2 回目の request が発行されず、
		// webRequest 層に届かないため。
		writeWorkspaceFiles(workspaceDir, {
			"note-a.md": "# A\n\n![a](https://remote.example/a.png)\n",
			"note-b.md": "# B\n\n![b](https://remote.example/b.png)\n",
		});
		markInitialized(workspaceDir);
		// 既定 ON で起動する（CSP は https: を許可した状態で document がロードされる）。
		seedSettings(userDataDir, { workspacePath: workspaceDir, sidebarVisible: true });

		const failures = new Map<string, string>();
		const { page } = await launch();
		page.on("requestfailed", (req) => {
			failures.set(req.url(), req.failure()?.errorText ?? "");
		});
		await recordCspViolations(page);

		// ON のうちは request が renderer を出る（= CSP が通している）。
		// 到達先は解決されないので失敗するが、cancel とは別の errorText になる。
		await page.getByLabel("note-a.md file").click();
		await expect
			.poll(() => failures.get("https://remote.example/a.png"))
			.toEqual(expect.any(String));
		expect(failures.get("https://remote.example/a.png")).not.toContain(BLOCKED_BY_CLIENT);

		// reload せずに設定だけ OFF にする。
		await setLoadRemoteImages(page, false);

		await page.getByLabel("note-b.md file").click();
		await expect
			.poll(() => failures.get("https://remote.example/b.png"))
			.toContain(BLOCKED_BY_CLIENT);

		// この document の CSP は起動時の（https: を許可した）ままなので、
		// 遮断したのは webRequest 層だけだと言い切れる。
		expect(await readCspViolations(page)).toEqual([]);
	});
});
