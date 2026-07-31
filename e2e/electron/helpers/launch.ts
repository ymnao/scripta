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
	// main process の stderr chunk を到着順に溜めたもの。listener は firstWindow を
	// 待つ前に張るため、起動直後の出力も取りこぼさない（spec 側で後から張ると
	// launch 完了までの窓が空く）。診断ログ / dark assert の warn を assert する
	// spec が join して使う。
	stderr: string[];
}

export interface LaunchOptions {
	// main process へ追加で渡す環境変数。`process.env` を **上書きマージ**するため、
	// 呼び手は差分だけを書けばよい（`{ ...process.env }` を自前で展開しない）。
	// dark assert (`SCRIPTA_DARK_ASSERT`) / PDF 診断 (`SCRIPTA_PDF_DEBUG`) のように
	// main 側の挙動を切り替えるフラグ用。
	env?: NodeJS.ProcessEnv;
}

// 起動毎に temp userData を切る。`app.setName("scripta")` は `app.isPackaged` 時のみ
// 発火し、unpackaged 起動（本 e2e）では "scripta-next" になる。だが `--user-data-dir`
// を渡すと `app.getPath("userData")` はこの temp dir に固定されるため、実機 userData
// を汚さず、Settings migration テストは temp 内へ legacy `settings.json` を seed できる。
// `process.env` に overrides を重ねて Playwright の env 型（`Record<string, string>`）へ
// 落とす。`NodeJS.ProcessEnv` は値が `string | undefined` なので、undefined の key は
// 「未設定」として落とす（そのまま渡すと型が合わないうえ、"undefined" 文字列化の危険もある）。
function mergeEnv(overrides: NodeJS.ProcessEnv): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
		if (value !== undefined) merged[key] = value;
	}
	return merged;
}

export async function launchScripta(
	userDataDir: string,
	options: LaunchOptions = {},
): Promise<LaunchResult> {
	const app = await electron.launch({
		args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
		// env 未指定時は `electron.launch` の既定（親プロセスの env をそのまま継承）に
		// 委ねる。指定時のみ明示マージした env を渡す（Playwright は env を渡すと
		// **置換**扱いにするため、process.env を必ず土台に敷く）。
		...(options.env ? { env: mergeEnv(options.env) } : {}),
	});
	const stderr: string[] = [];
	const stderrStream = app.process().stderr;
	if (stderrStream) {
		stderrStream.on("data", (chunk: Buffer | string) => {
			stderr.push(chunk.toString());
		});
	}
	const page = await app.firstWindow();
	await page.waitForLoadState("domcontentloaded");
	return { app, page, userDataDir, stderr };
}

interface ScriptaFixtures {
	// 起動毎に切られる temp userData。テストは launch 前に settings.json 等を
	// seed でき、同じ dir で再 launch すれば永続化を検証できる。
	userDataDir: string;
	// userData とは別の temp workspace ディレクトリ。画像・markdown 等を配置して
	// asset protocol / 画像描画 / workspace 復元のテスト対象にする。
	workspaceDir: string;
	// 実 Electron を起動する。第 1 引数省略時は fixture の userDataDir を使う。
	// fixture が生成した全 app を teardown で close するため、テスト側は
	// 再起動時も close を意識しなくてよい（明示 close したい場合は app.close()）。
	// 第 2 引数で env を上書きできる（main 側フラグを踏む spec 用、LaunchOptions 参照）。
	launch: (userDataDir?: string, options?: LaunchOptions) => Promise<LaunchResult>;
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
	// xvfb 上で稀に `app.close()` が 30s を超え fixture timeout (= test timeout
	// と共有、default 30s) に引っかかるため、teardown 単独に 60s の余裕を与える
	// (test 本体の timeout は default 30s 据え置きで本体 hang 検出は維持)。
	launch: [
		async ({ userDataDir }, use) => {
			const launched: ElectronApplication[] = [];
			const launch = async (
				dir: string = userDataDir,
				options: LaunchOptions = {},
			): Promise<LaunchResult> => {
				const result = await launchScripta(dir, options);
				launched.push(result.app);
				return result;
			};
			await use(launch);
			await Promise.all(launched.map((app) => app.close()));
		},
		{ timeout: 60_000 },
	],
});

// 実 Electron はホスト OS をそのまま使うため、修飾キーは host platform で決まる
// （macOS=Meta / その他=Control）。renderer-only mock helper の modKey と同義だが、
// _electron 側で完結させるため独立定義する。
export const modKey = process.platform === "darwin" ? "Meta" : "Control";

export { expect } from "@playwright/test";
