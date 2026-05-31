import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	test as base,
	type ElectronApplication,
	_electron as electron,
	type Page,
} from "@playwright/test";

// build 成果物の main エントリ。packaged build に最も近い形で起動するため
// electron-vite build の出力 (`out/main/index.js`) を直接 _electron.launch する。
// Vite dev server は介さない（設計判断: HANDOFF Phase 1 PR-3「build 成果物起動」）。
// production パスでは main が `loadFile("../renderer/index.html")` を呼ぶため、
// dev server なしで build 済み renderer がそのままロードされる。
//
// パスは `process.cwd()`（= playwright 実行時の repo root）基準で解決する。
// Playwright は test/helper を CJS へトランスパイルするため `import.meta.dirname`
// は使えない（"exports is not defined" で読み込み失敗する）。
const MAIN_ENTRY = resolve(process.cwd(), "out/main/index.js");

export interface LaunchResult {
	app: ElectronApplication;
	page: Page;
	userDataDir: string;
}

// 起動毎に temp userData を切る。`app.setName("scripta")` は `app.isPackaged` 時のみ
// 発火し、unpackaged 起動（本 e2e）では "scripta-next" になる。だが `--user-data-dir`
// を渡すと `app.getPath("userData")` はこの temp dir に固定されるため、実機 userData
// を汚さず、Settings migration テストは temp 内へ legacy `settings.json` を seed できる。
export async function launchScripta(userDataDir: string): Promise<LaunchResult> {
	const app = await electron.launch({
		args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
	});
	const page = await app.firstWindow();
	await page.waitForLoadState("domcontentloaded");
	return { app, page, userDataDir };
}

interface ScriptaFixtures {
	// 起動毎に切られる temp userData。テストは launch 前に settings.json 等を
	// seed でき、同じ dir で再 launch すれば永続化を検証できる。
	userDataDir: string;
	// userData とは別の temp workspace ディレクトリ。画像・markdown 等を配置して
	// asset protocol / 画像描画 / workspace 復元のテスト対象にする。
	workspaceDir: string;
	// 実 Electron を起動する。引数省略時は fixture の userDataDir を使う。
	// fixture が生成した全 app を teardown で close するため、テスト側は
	// 再起動時も close を意識しなくてよい（明示 close したい場合は app.close()）。
	launch: (userDataDir?: string) => Promise<LaunchResult>;
}

export const test = base.extend<ScriptaFixtures>({
	// 依存 fixture を持たないため第 1 引数は空 destructure `{}`（Playwright は第 1 引数を
	// object pattern に限定し、その destructure 名から依存を解決する。依存なしは `{}` が
	// 唯一の書き方で Playwright 公式もこの形）。biome の noEmptyPattern はこの Playwright
	// 由来の構造を誤検出するため、本ファイルに限り biome.json の override で当該ルールを off。
	userDataDir: async ({}, use) => {
		const dir = mkdtempSync(join(tmpdir(), "scripta-e2e-userdata-"));
		await use(dir);
		rmSync(dir, { recursive: true, force: true });
	},
	workspaceDir: async ({}, use) => {
		const dir = mkdtempSync(join(tmpdir(), "scripta-e2e-workspace-"));
		await use(dir);
		rmSync(dir, { recursive: true, force: true });
	},
	launch: async ({ userDataDir }, use) => {
		const launched: ElectronApplication[] = [];
		const launch = async (dir: string = userDataDir): Promise<LaunchResult> => {
			const result = await launchScripta(dir);
			launched.push(result.app);
			return result;
		};
		await use(launch);
		for (const app of launched) {
			await app.close();
		}
	},
});

// 実 Electron はホスト OS をそのまま使うため、修飾キーは host platform で決まる
// （macOS=Meta / その他=Control）。renderer-only mock helper の modKey と同義だが、
// _electron 側で完結させるため独立定義する。
export const modKey = process.platform === "darwin" ? "Meta" : "Control";

export { expect } from "@playwright/test";
