import { expect, test } from "@playwright/test";
import type { FileEntry } from "../src/types/workspace";
import { ElectronApiMock } from "./helpers/electron-api-mock";

// ファイルツリーがサイドバーの縦 viewport を超えたときにスクロールできることを固定する。
// #162 で Sidebar を .sidebar-wrapper (overflow-hidden) でラップした際、aside の
// 高さ制限チェーンが切れてスクロール不能になる regression があった。
// デフォルト viewport 720px / FileTreeItem ≈ 24px なので 35 件で余裕を持って overflow。
test("ファイルツリーがサイドバーの高さを超えたら縦スクロールできる", async ({ page }) => {
	const FILE_COUNT = 35;
	const entries: FileEntry[] = Array.from({ length: FILE_COUNT }, (_, i) => {
		const name = `file-${String(i).padStart(2, "0")}.md`;
		return { name, path: `/workspace/${name}`, isDirectory: false };
	});

	const mock = new ElectronApiMock(page);
	await mock.setup({
		fs: { files: {}, directories: { "/workspace": entries } },
		dialogResult: "/workspace",
	});

	await page.goto("/");
	await page.getByLabel("フォルダを開く").click();

	// 最後のファイルは初期表示で viewport 外 (= ツリーがあふれている前提の確認)
	const lastFile = page.getByLabel(`file-${FILE_COUNT - 1}.md file`);
	await expect(lastFile).not.toBeInViewport();

	// ツリー上でホイールスクロールすると最後のファイルまで到達できる
	await page.getByLabel("file-00.md file").hover();
	await page.mouse.wheel(0, FILE_COUNT * 30);
	await expect(lastFile).toBeInViewport();
});
