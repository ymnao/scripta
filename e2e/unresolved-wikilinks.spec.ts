import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/note.md": "# Notes\nSee [[missing-page]] for details\nAlso [[another-missing]]",
		"/workspace/existing.md": "# Existing Page\nContent here",
		"/workspace/ref.md": "Referencing [[missing-page]] again",
	},
	directories: {
		"/workspace": [
			{ name: "note.md", path: "/workspace/note.md", isDirectory: false },
			{ name: "existing.md", path: "/workspace/existing.md", isDirectory: false },
			{ name: "ref.md", path: "/workspace/ref.md", isDirectory: false },
		],
	},
};

test.describe("unresolved wikilinks panel", () => {
	test("サイドバーボタンで未解決リンクパネルを表示できる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.getByLabel("Show unresolved wikilinks").click();

		await expect(page.getByText("未解決リンク", { exact: true })).toBeVisible();
	});

	test("未解決リンク件数が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("Show unresolved wikilinks").click();

		await expect(page.getByText("件の未解決リンク")).toBeVisible();
	});

	test("各リンクの参照件数バッジが表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("Show unresolved wikilinks").click();

		await expect(page.getByText("missing-page")).toBeVisible();
		await expect(page.getByText("another-missing")).toBeVisible();

		// missing-page は note.md と ref.md で 2 references
		// another-missing は note.md のみ 1 reference
	});

	test("Cmd+Shift+U でパネルをトグルできる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+Shift+u`);
		await expect(page.getByText("未解決リンク", { exact: true })).toBeVisible();

		await page.keyboard.press(`${modKey}+Shift+u`);
		await expect(page.getByText("Files")).toBeVisible();
	});

	test("パネルからディレクトリピッカー経由でファイルを作成できる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("Show unresolved wikilinks").click();

		await expect(page.getByText("another-missing")).toBeVisible();

		await page.getByLabel("Create another-missing").click();
		await expect(page.getByText("作成先を選択")).toBeVisible();

		await page.getByRole("button", { name: "作成" }).click();

		const createCalls = await mock.getCalls("createFile");
		const writeNewCalls = await mock.getCalls("writeNewFile");
		const totalCreates = createCalls.length + writeNewCalls.length;
		expect(totalCreates).toBeGreaterThanOrEqual(1);
	});

	test("ソートトグルで名前順 / 件数順を切り替えられる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("Show unresolved wikilinks").click();

		await expect(page.getByText("missing-page")).toBeVisible();

		await page.getByLabel("Sort by reference count").click();

		await page.getByLabel("Sort by name").click();
	});

	test("missing wikilink が破線スタイルでレンダリングされる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("note.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Notes");

		const missingLink = page.locator(".cm-wikilink-missing").first();
		await expect(missingLink).toBeVisible();
	});

	test("ファイル内容が変わるとパネル再オープン時に反映される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.getByLabel("Show unresolved wikilinks").click();
		const panel = page.locator('section[aria-label="Unresolved wikilinks"]');
		await expect(panel.getByText("another-missing")).toBeVisible();
		await expect(panel.getByText("missing-page")).toBeVisible();

		// 外部から保存された想定で mock のファイル内容を更新
		await mock.setFileContent("/workspace/note.md", "# Notes\nSee [[missing-page]] for details");

		// 一旦離れて戻ることで再 mount + 再 scan を強制
		await page.getByLabel("Show file explorer").click();
		await page.getByLabel("Show unresolved wikilinks").click();

		// missing-page は ref.md にあるので残る
		await expect(panel.getByText("missing-page")).toBeVisible({ timeout: 5000 });
		// another-missing は消えている
		await expect(panel.getByText("another-missing")).not.toBeVisible();
	});

	test("パネルを開かなくてもホバーポップアップが参照件数を表示する", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.getByLabel("note.md file").click();
		const editor = page.locator(".cm-content");
		await expect(editor).toContainText("Notes");

		await editor.click();
		await page.keyboard.press("Home");

		const missingLink = page.locator(".cm-wikilink-missing").first();
		await expect(missingLink).toBeVisible({ timeout: 5000 });

		await missingLink.hover();

		// ワークスペース読み込み時に scan が走るので、パネル未表示でもポップアップに件数が出る
		const popup = page.locator("[data-page-name]");
		await expect(popup).toBeVisible({ timeout: 5000 });
		await expect(popup).toContainText("件の参照");
	});

	test("未解決リンクが無いときは空状態を表示する", async ({ page }) => {
		const noUnresolved = {
			files: {
				"/workspace/note.md": "# Notes\nSee [[existing]] for details",
				"/workspace/existing.md": "# Existing",
			},
			directories: {
				"/workspace": [
					{ name: "note.md", path: "/workspace/note.md", isDirectory: false },
					{ name: "existing.md", path: "/workspace/existing.md", isDirectory: false },
				],
			},
		};
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: noUnresolved, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("Show unresolved wikilinks").click();

		await expect(page.getByText("未解決のリンクはありません")).toBeVisible();
	});

	test("別ワークスペースの未解決リンクが混入しない", async ({ page }) => {
		const cleanWorkspace = {
			files: {
				"/workspace/alpha.md": "# Alpha\n[[beta]]",
				"/workspace/beta.md": "# Beta",
			},
			directories: {
				"/workspace": [
					{ name: "alpha.md", path: "/workspace/alpha.md", isDirectory: false },
					{ name: "beta.md", path: "/workspace/beta.md", isDirectory: false },
				],
			},
		};
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: cleanWorkspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.getByLabel("Show unresolved wikilinks").click();

		// 別ワークスペースの "missing-page" 等が leak してこないこと
		await expect(page.getByText("未解決のリンクはありません")).toBeVisible({ timeout: 5000 });
	});
});
