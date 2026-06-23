import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/target.md": "# Target Note",
		"/workspace/a.md": "See [[target]] for details",
		"/workspace/b.md": "Refers to [[target|aliased]]",
		"/workspace/c.md": "No links here",
	},
	directories: {
		"/workspace": [
			{ name: "target.md", path: "/workspace/target.md", isDirectory: false },
			{ name: "a.md", path: "/workspace/a.md", isDirectory: false },
			{ name: "b.md", path: "/workspace/b.md", isDirectory: false },
			{ name: "c.md", path: "/workspace/c.md", isDirectory: false },
		],
	},
};

test.describe("backlink panel", () => {
	test("サイドバーボタンでバックリンクパネルを表示できる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		await page.getByLabel("バックリンクを表示").click();
		await expect(page.getByText("バックリンク", { exact: true })).toBeVisible();
	});

	test("対象ファイル未選択時は案内メッセージを表示する", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("バックリンクを表示").click();

		await expect(
			page.getByText("バックリンクを表示するには Markdown ファイルを開いてください"),
		).toBeVisible();
	});

	test("対象ノートを開くと参照しているファイル一覧が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("target.md file").click();
		await page.getByLabel("バックリンクを表示").click();

		const panel = page.locator('section[aria-label="バックリンク"]');
		await expect(panel.locator(".search-panel-file-name").filter({ hasText: "a.md" })).toBeVisible({
			timeout: 5000,
		});
		await expect(
			panel.locator(".search-panel-file-name").filter({ hasText: "b.md" }),
		).toBeVisible();
		// c.md は参照していないので含まれない
		await expect(panel.locator(".search-panel-file-name").filter({ hasText: "c.md" })).toHaveCount(
			0,
		);
	});

	test("複数参照を含むファイルは参照件数バッジを表示する", async ({ page }) => {
		const multiRefWorkspace = {
			files: {
				"/workspace/target.md": "# Target",
				"/workspace/multi.md": "[[target]] one\n[[target]] two",
			},
			directories: {
				"/workspace": [
					{ name: "target.md", path: "/workspace/target.md", isDirectory: false },
					{ name: "multi.md", path: "/workspace/multi.md", isDirectory: false },
				],
			},
		};
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: multiRefWorkspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("target.md file").click();
		await page.getByLabel("バックリンクを表示").click();

		const multiRow = page.locator(".search-panel-file-header", {
			has: page.getByText("multi.md", { exact: true }),
		});
		await expect(multiRow.locator(".search-panel-file-count")).toHaveText("2", {
			timeout: 5000,
		});
	});

	test("Cmd+Shift+B でパネルをトグルできる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		await page.keyboard.press(`${modKey}+Shift+b`);
		await expect(page.getByText("バックリンク", { exact: true })).toBeVisible();

		await page.keyboard.press(`${modKey}+Shift+b`);
		await expect(page.getByText("Files")).toBeVisible();
	});

	test("対象ノート自身からのリンクは backlink に含まれない", async ({ page }) => {
		const selfRefWorkspace = {
			files: {
				"/workspace/target.md": "# Target\nHere I [[target]] myself.",
				"/workspace/other.md": "References [[target]]",
			},
			directories: {
				"/workspace": [
					{ name: "target.md", path: "/workspace/target.md", isDirectory: false },
					{ name: "other.md", path: "/workspace/other.md", isDirectory: false },
				],
			},
		};
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: selfRefWorkspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("target.md file").click();
		await page.getByLabel("バックリンクを表示").click();

		const panel = page.locator('section[aria-label="バックリンク"]');
		await expect(
			panel.locator(".search-panel-file-name").filter({ hasText: "other.md" }),
		).toBeVisible({ timeout: 5000 });
		await expect(
			panel.locator(".search-panel-file-name").filter({ hasText: "target.md" }),
		).toHaveCount(0);
	});

	test("バックリンクが無いときは空状態を表示する", async ({ page }) => {
		const orphanWorkspace = {
			files: {
				"/workspace/orphan.md": "# Orphan\nNo one references me.",
				"/workspace/other.md": "Some content with [[different-target]]",
			},
			directories: {
				"/workspace": [
					{ name: "orphan.md", path: "/workspace/orphan.md", isDirectory: false },
					{ name: "other.md", path: "/workspace/other.md", isDirectory: false },
				],
			},
		};
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: orphanWorkspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("orphan.md file").click();
		await page.getByLabel("バックリンクを表示").click();

		await expect(page.getByText("バックリンクはありません")).toBeVisible({ timeout: 5000 });
	});

	test("対象ノート切り替えで panel 内容が追従する", async ({ page }) => {
		const twoTargetsWorkspace = {
			files: {
				"/workspace/x.md": "About X",
				"/workspace/y.md": "About Y",
				"/workspace/ref-x.md": "see [[x]]",
				"/workspace/ref-y.md": "see [[y]]",
			},
			directories: {
				"/workspace": [
					{ name: "x.md", path: "/workspace/x.md", isDirectory: false },
					{ name: "y.md", path: "/workspace/y.md", isDirectory: false },
					{ name: "ref-x.md", path: "/workspace/ref-x.md", isDirectory: false },
					{ name: "ref-y.md", path: "/workspace/ref-y.md", isDirectory: false },
				],
			},
		};
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: twoTargetsWorkspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		// backlink panel を開くと FileTree が隠れるため、ファイル選択 → panel 表示
		// → file panel に戻って次のファイル選択 → panel 再表示、の順で切り替える。
		await page.getByLabel("x.md file").click();
		await page.getByLabel("バックリンクを表示").click();

		const panel = page.locator('section[aria-label="バックリンク"]');
		await expect(
			panel.locator(".search-panel-file-name").filter({ hasText: "ref-x.md" }),
		).toBeVisible({ timeout: 5000 });
		await expect(
			panel.locator(".search-panel-file-name").filter({ hasText: "ref-y.md" }),
		).toHaveCount(0);

		await page.getByLabel("ファイルエクスプローラーを表示").click();
		await page.getByLabel("y.md file").click();
		await page.getByLabel("バックリンクを表示").click();
		await expect(
			panel.locator(".search-panel-file-name").filter({ hasText: "ref-y.md" }),
		).toBeVisible({ timeout: 5000 });
		await expect(
			panel.locator(".search-panel-file-name").filter({ hasText: "ref-x.md" }),
		).toHaveCount(0);
	});
});
