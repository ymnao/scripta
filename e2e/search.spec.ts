import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/hello.md": "# Hello World\nThis is a test file\nHello again",
		"/workspace/notes.md": "Some notes here\nhello from notes",
	},
	directories: {
		"/workspace": [
			{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
			{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
		],
	},
};

test.describe("in-file search", () => {
	test("Cmd+F で検索バーが開く", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.keyboard.press(`${modKey}+f`);
		await expect(page.locator(".search-bar")).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Find" })).toBeVisible();
	});

	test("サイドバーにフォーカスがある状態でも Cmd+F で検索バーが開く", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.getByLabel("notes.md file").click();
		await page.keyboard.press(`${modKey}+f`);
		await expect(page.locator(".search-bar")).toBeVisible();
	});

	test("Escape で検索バーが閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await page.keyboard.press(`${modKey}+f`);
		await expect(page.locator(".search-bar")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.locator(".search-bar")).not.toBeVisible();
	});

	test("Cmd+H で置換フィールドが表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await page.keyboard.press(`${modKey}+h`);
		await expect(page.locator(".search-bar")).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Replace" })).toBeVisible();
	});

	test("検索時にマッチ件数が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.keyboard.press(`${modKey}+f`);
		await page.getByRole("textbox", { name: "Find" }).fill("Hello");
		await expect(page.locator(".search-bar-match-count")).toContainText(/\d+ (of \d+|results)/);
	});

	test("ボタンでマッチ間を移動できる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.keyboard.press(`${modKey}+f`);
		await page.getByRole("textbox", { name: "Find" }).fill("Hello");

		await page.getByLabel("Next match").click();
		await expect(page.locator(".search-bar-match-count")).toContainText(/\d+ of \d+/);
	});

	test("展開ボタンで置換フィールドをトグルできる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await page.keyboard.press(`${modKey}+f`);
		await expect(page.locator(".search-bar")).toBeVisible();

		// Cmd+F は collapsed で開くので、最初は Replace は非表示
		await expect(page.getByRole("textbox", { name: "Replace" })).not.toBeVisible();

		await page.getByLabel("Expand replace").click();
		await expect(page.getByRole("textbox", { name: "Replace" })).toBeVisible();

		await page.getByLabel("Collapse replace").click();
		await expect(page.getByRole("textbox", { name: "Replace" })).not.toBeVisible();
	});
});

test.describe("workspace search", () => {
	test("Cmd+Shift+F で検索パネルが開く", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+Shift+f`);
		await expect(page.getByText("Search", { exact: true })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Search in workspace" })).toBeVisible();
	});

	test("虫眼鏡アイコンでも検索パネルを開ける", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.getByLabel("Search in workspace").click();
		await expect(page.getByText("Search", { exact: true })).toBeVisible();
		await expect(page.getByRole("textbox", { name: "Search in workspace" })).toBeVisible();
	});

	test("検索結果がファイルごとにグルーピング表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+Shift+f`);
		await page.getByRole("textbox", { name: "Search in workspace" }).fill("hello");

		await expect(page.locator(".search-panel-file-header")).toHaveCount(2, { timeout: 5000 });
		await expect(page.locator(".search-panel-file-header").first()).toContainText("hello.md");
		await expect(page.locator(".search-panel-file-header").last()).toContainText("notes.md");
	});

	test("検索結果クリックで該当ファイル / 行に遷移する", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+Shift+f`);
		await page.getByRole("textbox", { name: "Search in workspace" }).fill("hello");

		await expect(page.locator(".search-panel-match").first()).toBeVisible({ timeout: 5000 });
		await page.locator(".search-panel-match").first().click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");
	});

	test("サロゲートペアを含む行でも正しい範囲がハイライトされる", async ({ page }) => {
		const emojiWorkspace = {
			files: {
				"/workspace/emoji.md": "😀hello world\n🎉🎊 test file\nnormal line hello",
			},
			directories: {
				"/workspace": [{ name: "emoji.md", path: "/workspace/emoji.md", isDirectory: false }],
			},
		};
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: emojiWorkspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+Shift+f`);
		await page.getByRole("textbox", { name: "Search in workspace" }).fill("hello");

		const highlights = page.locator(".search-panel-highlight");
		await expect(highlights.first()).toBeVisible({ timeout: 5000 });

		// 各 <mark> は "hello" のみで、サロゲートペアの破片は含まない
		await expect(highlights).toHaveCount(2);
		await expect(highlights.nth(0)).toHaveText("hello");
		await expect(highlights.nth(1)).toHaveText("hello");
	});

	test("複数 emoji 直後のクエリも正しくハイライトされる", async ({ page }) => {
		const emojiWorkspace = {
			files: {
				"/workspace/emoji.md": "🎉🎊test",
			},
			directories: {
				"/workspace": [{ name: "emoji.md", path: "/workspace/emoji.md", isDirectory: false }],
			},
		};
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: emojiWorkspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+Shift+f`);
		await page.getByRole("textbox", { name: "Search in workspace" }).fill("test");

		const highlight = page.locator(".search-panel-highlight");
		await expect(highlight).toBeVisible({ timeout: 5000 });
		await expect(highlight).toHaveText("test");
	});

	test("ファイルアイコンクリックで file explorer に戻る", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.getByRole("button", { name: "Search in workspace" }).click();
		await expect(page.getByText("Search", { exact: true })).toBeVisible();

		await page.getByRole("button", { name: "Show file explorer" }).click();
		await expect(page.getByText("Files")).toBeVisible();
	});
});
