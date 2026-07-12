import { join } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow, protocol, session } from "electron";
import { registerIpcHandlers } from "./ipc";
import { getWindowState, persistWindowState } from "./ipc/settings";
import { approveSavedWorkspaceForWindow, markWorkspacePersistenceVolatile } from "./ipc/workspace";
import { setApplicationMenu } from "./menu";
import { installMainSessionPermissionHandlers } from "./utils/permission-handler";
import { registerScriptaAssetProtocol, SCRIPTA_ASSET_SCHEME } from "./utils/scripta-asset-protocol";
import { MAIN_WINDOW_TITLE_BAR_OPTIONS } from "./utils/window-defaults";
import { attachNavigationGuards } from "./utils/window-guards";
import { attachWindowLifecycle } from "./utils/window-lifecycle";
import { attachWindowStateTracker, resolveInitialGeometry } from "./utils/window-state";

// ローカル画像配信用スキーム。
// CSP `img-src` に許可するのは本スキームだけで、`file:` は許可しない。これによりファイル
// アクセスは必ず `protocol.handle` のハンドラ → path-guard を経由する（任意 file 読み取り
// 防止）。`registerSchemesAsPrivileged` は `app.ready` より前に呼ぶ必要がある（Electron）。
// 実際の handler 登録は utils/scripta-asset-protocol.ts に集約 (PDF export の隔離 partition
// からも同じロジックで登録するため)。
protocol.registerSchemesAsPrivileged([
	{
		scheme: SCRIPTA_ASSET_SCHEME,
		privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
	},
]);

// Electron は app.getPath("userData") を app.getName() (= packaged package.json
// の name / productName) ベースで解決する。本リポジトリの package.json:name は
// "scripta-next" のままだが、既存の配布済みアプリ (productName = "scripta") の userData
// ディレクトリ (~/Library/Application Support/scripta 等) を継続利用するため、
// app.whenReady() で userData が確定する前に明示上書きする。
//
// 互換維持が必要なのは packaged 配布物だけ。pnpm dev では package.json:name の
// "scripta-next" のままにし、開発中の sidebar/workspacePath/window state 操作が
// 本番アプリの設定を汚染するのを防ぐ。
if (app.isPackaged) {
	app.setName("scripta");
}

const CSP_PROD = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	`img-src 'self' https: data: blob: ${SCRIPTA_ASSET_SCHEME}:`,
	"font-src 'self' data:",
	"connect-src 'self'",
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'self'",
].join("; ");

const CSP_DEV = [
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
	`img-src 'self' https: data: blob: ${SCRIPTA_ASSET_SCHEME}:`,
	"font-src 'self' data:",
	"connect-src 'self' ws://localhost:* http://localhost:*",
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'self'",
].join("; ");

const openWindows = new Set<BrowserWindow>();

interface CreateWindowOptions {
	// メニューの "New Window" から呼ばれる場合は state 復元せずデフォルト bounds で開き、
	// renderer 側 AppLayout に `?newWindow=true` を伝えて workspace 復元を抑止する。
	// （`AppLayout.tsx` の `isNewWindow` 分岐を参照）
	newWindow?: boolean;
}

async function createWindow(opts: CreateWindowOptions = {}): Promise<void> {
	const isNew = opts.newWindow === true;
	const initial = isNew ? resolveInitialGeometry(null) : resolveInitialGeometry(getWindowState());
	const mainWindow = new BrowserWindow({
		x: initial.bounds.x,
		y: initial.bounds.y,
		width: initial.bounds.width,
		height: initial.bounds.height,
		show: false,
		...MAIN_WINDOW_TITLE_BAR_OPTIONS,
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	openWindows.add(mainWindow);
	attachWindowLifecycle(mainWindow, () => {
		openWindows.delete(mainWindow);
	});
	if (isNew) {
		// 補助ウィンドウからの workspace:set では settings.json の workspacePath を
		// 上書きさせない（startup の workspace 復元抑止と整合させる）。
		markWorkspacePersistenceVolatile(mainWindow.webContents.id);
	} else {
		// 非補助ウィンドウには saved workspace を approve する。renderer が
		// workspace:set を打つ前に完了させるため loadFile/loadURL より前に await。
		await approveSavedWorkspaceForWindow(mainWindow.webContents.id);
	}
	// New Window は state 永続化対象から外す（メイン window の bounds が上書きされる
	// と「サブで一瞬開いただけ」のサイズで次回起動時にメイン window が起動する）
	if (!isNew) {
		// 書き込みは sync 一本（race を避けるため）。debounce 500ms により
		// 頻度は drag/resize 連打中でも収束する。
		attachWindowStateTracker(mainWindow, { save: persistWindowState });

		// 起動直後のフラッシュを避けるため maximize / fullScreen は loadFile/URL の
		// 後で適用する。BrowserWindow の constructor が x/y/width/height を受け取った
		// 後に maximize() を呼ぶと、unmaximize 時に正しい normalBounds が残る。
		if (initial.maximize) mainWindow.maximize();
		if (initial.fullScreen) mainWindow.setFullScreen(true);
	}

	mainWindow.on("ready-to-show", () => {
		mainWindow.show();
	});

	// 外部 URL / 任意ローカル HTML への遷移は全て deny し、安全な外部 URL は OS の
	// デフォルトブラウザに委譲する。conflict window 等の他 BrowserWindow にも同じ
	// guard を必ず install すること（window-guards.ts 参照）。
	attachNavigationGuards(mainWindow.webContents);

	const search = isNew ? "?newWindow=true" : undefined;
	if (process.env.ELECTRON_RENDERER_URL) {
		const url = search
			? `${process.env.ELECTRON_RENDERER_URL}${search}`
			: process.env.ELECTRON_RENDERER_URL;
		void mainWindow.loadURL(url).catch((error) => {
			console.error("Failed to load renderer URL:", error);
		});
	} else {
		const loadOpts = search ? { search } : undefined;
		void mainWindow.loadFile(join(__dirname, "../renderer/index.html"), loadOpts).catch((error) => {
			console.error("Failed to load renderer file:", error);
		});
	}
}

if (is.dev) {
	app.on("browser-window-created", (_, window) => {
		optimizer.watchWindowShortcuts(window);
	});
}

app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.whenReady().then(async () => {
	electronApp.setAppUserModelId("com.scripta.app");
	registerIpcHandlers();
	registerScriptaAssetProtocol();
	// Electron Security Checklist Item #5: main renderer に対する permission を
	// 明示的に管理する。scripta は基本「全 deny」で、エディタの「貼り付け」
	// （navigator.clipboard.readText）と「コピー / 切り取り」（writeText）のみ
	// 信頼 renderer origin に限り許可する（permission-handler.ts 参照）。
	installMainSessionPermissionHandlers(session.defaultSession);
	setApplicationMenu({ newWindow: () => void createWindow({ newWindow: true }) });
	const cspTargetUrls = process.env.ELECTRON_RENDERER_URL
		? [`${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, "")}/*`]
		: ["file:///*"];
	session.defaultSession.webRequest.onHeadersReceived(
		{ urls: cspTargetUrls },
		(details, callback) => {
			const cleaned = Object.fromEntries(
				Object.entries(details.responseHeaders ?? {}).filter(
					([name]) => name.toLowerCase() !== "content-security-policy",
				),
			);
			callback({
				responseHeaders: {
					...cleaned,
					"Content-Security-Policy": [is.dev ? CSP_DEV : CSP_PROD],
				},
			});
		},
	);
	await createWindow();
});
