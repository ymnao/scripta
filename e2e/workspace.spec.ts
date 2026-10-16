import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

test.describe("workspace", () => {
	test("ワークスペースを開くとファイルツリーが表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: {
				files: {
					"/workspace/hello.md": "# Hello",
					"/workspace/notes.md": "Some notes",
				},
				directories: {
					"/workspace": [
						{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
						{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
					],
				},
			},
			dialogResult: "/workspace",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await expect(page.getByLabel("hello.md file")).toBeVisible();
		await expect(page.getByLabel("notes.md file")).toBeVisible();
	});

	test("フォルダを展開すると子要素が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: {
				files: {
					"/workspace/docs/readme.md": "# Readme",
				},
				directories: {
					"/workspace": [{ name: "docs", path: "/workspace/docs", isDirectory: true }],
					"/workspace/docs": [
						{ name: "readme.md", path: "/workspace/docs/readme.md", isDirectory: false },
					],
				},
			},
			dialogResult: "/workspace",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await expect(page.getByLabel("docs folder")).toBeVisible();

		await page.getByLabel("docs folder").click();
		await expect(page.getByLabel("readme.md file")).toBeVisible();
	});

	test("コンテキストメニュー「フォルダで表示」が showInFolder を呼び出す", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: {
				files: {
					"/workspace/hello.md": "# Hello",
				},
				directories: {
					"/workspace": [{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false }],
				},
			},
			dialogResult: "/workspace",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click({ button: "right" });
		await page.getByText("フォルダで表示").click();

		const calls = await mock.getCalls("showInFolder");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual(["/workspace/hello.md"]);
	});

	test("コンテキストメニューからフォルダを作成できる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: {
				files: {
					"/workspace/hello.md": "# Hello",
				},
				directories: {
					"/workspace": [{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false }],
				},
			},
			dialogResult: "/workspace",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await expect(page.getByLabel("hello.md file")).toBeVisible();

		await page.getByLabel("hello.md file").click({ button: "right" });
		await page.getByText("New Folder").click();

		const input = page.getByRole("textbox", { name: "New folder name" });
		await expect(input).toBeVisible();
		await input.fill("my-folder");
		await input.press("Enter");

		// createDirectory が呼ばれて createFile は呼ばれない
		const dirCalls = await mock.getCalls("createDirectory");
		expect(dirCalls).toHaveLength(1);
		expect(dirCalls[0]).toEqual(["/workspace/my-folder"]);

		const fileCalls = await mock.getCalls("createFile");
		expect(fileCalls).toHaveLength(0);

		await expect(page.getByLabel("my-folder folder")).toBeVisible();
	});

	test("新しいファイルは入力欄の右に .md が固定表示され、名前に .md を付けて作られる", async ({
		page,
	}) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: {
				files: {
					"/workspace/hello.md": "# Hello",
				},
				directories: {
					"/workspace": [{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false }],
				},
			},
			dialogResult: "/workspace",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await expect(page.getByLabel("hello.md file")).toBeVisible();

		await page.getByLabel("hello.md file").click({ button: "right" });
		await page.getByText("New File").click();

		const input = page.getByRole("textbox", { name: "New file name" });
		await expect(input).toBeVisible();
		const suffix = page
			.getByRole("listitem")
			.filter({ has: input })
			.getByText(".md", { exact: true });
		await expect(suffix).toBeVisible();
		const inputBox = await input.boundingBox();
		const suffixBox = await suffix.boundingBox();
		expect(suffixBox?.x).toBeGreaterThanOrEqual((inputBox?.x ?? 0) + (inputBox?.width ?? 0));

		await input.fill("memo");
		await input.press("Enter");

		expect(await mock.getCalls("createFile")).toEqual([["/workspace/memo.md"]]);
		await expect(page.getByLabel("memo.md file")).toBeVisible();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await expect(page.getByRole("tab")).toContainText("memo");

		await page.keyboard.press(`${modKey}+p`);
		await page.getByLabel("ファイル名で検索").fill("memo");
		const options = page.getByRole("listbox", { name: "検索結果" }).getByRole("option");
		await expect(options).toHaveCount(1);
		await expect(options.nth(0)).toContainText("memo.md");
	});

	test("ワークスペース未選択時は empty state を表示する", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({});

		await page.goto("/");
		await expect(page.getByText("フォルダを開いて始めましょう")).toBeVisible();
	});

	test("削除確認ダイアログが狭いビューポートに収まる", async ({ page }) => {
		await page.setViewportSize({ width: 800, height: 500 });
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: {
				files: { "/workspace/hello.md": "# Hello" },
				directories: {
					"/workspace": [{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false }],
				},
			},
			dialogResult: "/workspace",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click({ button: "right" });
		await page.getByText("Delete").click();

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();
		const box = await dialog.boundingBox();
		expect(box?.height).toBeLessThanOrEqual(500);

		await expect(page.getByRole("button", { name: "キャンセル" })).toBeVisible();
		await expect(page.getByRole("button", { name: "削除" })).toBeVisible();
	});

	test("絵文字入力ダイアログが狭いビューポートに収まる", async ({ page }) => {
		await page.setViewportSize({ width: 800, height: 500 });
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: {
				files: { "/workspace/hello.md": "# Hello" },
				directories: {
					"/workspace": [{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false }],
					"/workspace/.scripta": [],
				},
			},
			dialogResult: "/workspace",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click({ button: "right" });
		await page.getByText("アイコンを設定...").click();

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();
		await expect(page.getByText("アイコンを設定")).toBeVisible();
		const box = await dialog.boundingBox();
		expect(box?.height).toBeLessThanOrEqual(500);

		await expect(page.getByLabel("絵文字一覧")).toBeVisible();
		await expect(page.getByRole("button", { name: "設定", exact: true })).toBeVisible();
	});
});
