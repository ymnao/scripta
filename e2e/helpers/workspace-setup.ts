import { expect, type Page } from "@playwright/test";
import type { FileEntry } from "../../src/types/workspace";
import { ElectronApiMock } from "./electron-api-mock";

/**
 * 「ワークスペースを 1 つ用意してファイルを 1 つ開く」までの定型 boilerplate を
 * 1 関数に集約する。spec 側は `await openSingleFileWorkspace(page, { ... })`
 * で `{ mock, editor }` を受け取って実テストに入れる。
 *
 * 個別 spec が `mock.setup({fs}) → goto → Open folder → click file → wait editor`
 * を毎回手書きしていた状況（link-cards.spec / link-widget.spec / context-menu.spec
 * 等で 10+ 重複）を解消する。
 *
 * `files` から `directories` マップを自動生成する: 各ディレクトリの直下にある
 * ファイル/フォルダを列挙したフラットな構造のみ対応（テスト用なので十分）。
 *
 * @param fileLabel `getByLabel(...)` で open するファイルラベル。未指定なら
 *   `files` の最初の path の basename + " file"（例: `links.md file`）。
 */
export async function openSingleFileWorkspace(
	page: Page,
	options: {
		files: Record<string, string>;
		workspacePath?: string;
		fileLabel?: string;
		settings?: Record<string, unknown>;
	},
): Promise<{ mock: ElectronApiMock; editor: ReturnType<Page["locator"]> }> {
	const workspacePath = options.workspacePath ?? "/workspace";
	const paths = Object.keys(options.files);
	if (paths.length === 0) throw new Error("openSingleFileWorkspace: files is empty");

	const directories = buildDirectories(workspacePath, paths);
	const firstFile = paths[0];
	const fileLabel = options.fileLabel ?? `${basename(firstFile)} file`;

	const mock = new ElectronApiMock(page);
	await mock.setup({
		fs: { files: options.files, directories },
		dialogResult: workspacePath,
		settings: options.settings,
	});
	await page.goto("/");
	await page.getByLabel("フォルダを開く").click();
	await page.getByLabel(fileLabel).click();

	const editor = page.locator(".cm-content");
	await expect(editor).toBeVisible();

	return { mock, editor };
}

function basename(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx >= 0 ? path.slice(idx + 1) : path;
}

function buildDirectories(workspacePath: string, paths: string[]): Record<string, FileEntry[]> {
	const entries: FileEntry[] = paths
		.filter(
			(p) => p.startsWith(`${workspacePath}/`) && !p.slice(workspacePath.length + 1).includes("/"),
		)
		.map((p) => ({ name: basename(p), path: p, isDirectory: false }));
	return { [workspacePath]: entries };
}
