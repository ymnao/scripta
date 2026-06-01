import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// 実 main が読み書きする settings.json は `<userData>/settings.json` のフラットな
// JSON オブジェクト（`electron/main/ipc/settings.ts` の Store 参照）。これらヘルパーで
// launch 前の seed / launch 後の検証を行い、設定永続化・migration を実 IPC 越しに踏む。

export type Settings = Record<string, unknown>;

function settingsPath(userDataDir: string): string {
	return join(userDataDir, "settings.json");
}

// launch 前に userData へ settings.json を seed する。旧 Tauri 版 `theme` キー等の
// legacy 形式もそのまま書けるため、Settings migration テストの起点に使える。
export function seedSettings(userDataDir: string, settings: Settings): void {
	mkdirSync(userDataDir, { recursive: true });
	writeFileSync(settingsPath(userDataDir), JSON.stringify(settings, null, 2), "utf8");
}

// launch 後の settings.json を読む。migration（旧キー削除・新キー書込）や
// UI 操作後の永続化を実ファイルベースで検証する。未生成なら null。
export function readSettings(userDataDir: string): Settings | null {
	try {
		const raw = readFileSync(settingsPath(userDataDir), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			return parsed as Settings;
		}
		return null;
	} catch {
		return null;
	}
}

// workspace ディレクトリにファイル群を書き出す。キーは workspace ルートからの
// 相対パス、値はテキスト or バイナリ（Buffer）。画像 fixture もこれで配置する。
export function writeWorkspaceFiles(
	workspaceDir: string,
	files: Record<string, string | Uint8Array>,
): void {
	for (const [relPath, content] of Object.entries(files)) {
		const absPath = join(workspaceDir, relPath);
		mkdirSync(dirname(absPath), { recursive: true });
		writeFileSync(absPath, content);
	}
}

// launch 後に workspace 内のテキストファイルを utf8 で読む。実 main が `fs:write`
// 経由で書いた内容をディスクから検証するためのもの（autosave / 手動保存の実 IPC
// 往復確認）。PDF 等のバイナリ検証には使わない（`%PDF` のように先頭が ASCII の
// magic header だけ確認する用途なら utf8 read でも先頭は保持される）。
export function readWorkspaceFile(workspaceDir: string, relPath: string): string {
	return readFileSync(join(workspaceDir, relPath), "utf8");
}

// launch 後に workspace 内ファイルの存在とサイズを返す。PDF エクスポートのように
// 「ファイルが生成されたか」「中身が空でないか」だけ確認したいケース用。
export function workspaceFileSize(workspaceDir: string, relPath: string): number | null {
	try {
		return statSync(join(workspaceDir, relPath)).size;
	} catch {
		return null;
	}
}

// workspace を「初期化済み」扱いにして SetupWizardDialog の自動表示を抑止する。
// 判定は `<workspace>/.scripta/initialized.json` の存在（src/lib/scripta-config.ts）。
// ファイルツリー操作を伴うテストでは、この modal が click を遮るため事前に置く。
export function markInitialized(workspaceDir: string): void {
	writeWorkspaceFiles(workspaceDir, {
		".scripta/initialized.json": JSON.stringify({ initializedAt: "2026-01-01T00:00:00.000Z" }),
	});
}

// 最小の有効な PNG（1x1 透明）。asset protocol / 画像描画テストの fixture 画像。
// 外部ファイルを持たずテスト内で完結させるため base64 を埋め込む。
const PNG_1X1_TRANSPARENT_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

export function tinyPng(): Uint8Array {
	return Buffer.from(PNG_1X1_TRANSPARENT_BASE64, "base64");
}
