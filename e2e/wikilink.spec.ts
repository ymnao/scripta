import { expect, test } from "@playwright/test";
import { ElectronApiMock } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/note.md": "# Note\n\nThis is a note.",
		"/workspace/index.md":
			"# Index\n\nLink to [[note]]\n\nAlias [[note|My Note]]\n\nMissing [[nonexistent]]\n\nNoSpace abc[[note]]def",
	},
	directories: {
		"/workspace": [
			{ name: "note.md", path: "/workspace/note.md", isDirectory: false },
			{ name: "index.md", path: "/workspace/index.md", isDirectory: false },
		],
	},
};

test.describe("wikilink preview", () => {
	test("カーソルが離れていると [[page]] がリンクとしてレンダリングされる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("index.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press("Home");

		await expect(page.locator(".cm-wikilink").first()).toBeVisible({ timeout: 5000 });
	});

	test("エディタフォーカスが無くても No-space wikilink がレンダリングされる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("index.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// エディタはクリックしない（フォーカス無し）
		await expect(page.locator(".cm-wikilink").first()).toBeVisible({ timeout: 5000 });

		// 4 つの wikilink がレンダリングされる: [[note]], [[note|My Note]], [[nonexistent]], abc[[note]]def
		const wikilinkCount = await page.locator(".cm-wikilink").count();
		expect(wikilinkCount).toBeGreaterThanOrEqual(4);
	});

	test("missing な wikilink のクリックでディレクトリピッカーが開く", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("index.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press("Home");

		const missingLink = page.locator(".cm-wikilink-missing").first();
		await expect(missingLink).toBeVisible({ timeout: 5000 });
		await missingLink.click();

		await expect(page.getByText("作成先を選択")).toBeVisible({ timeout: 5000 });

		await page.getByRole("button", { name: "作成" }).click();

		await expect(page.getByRole("tab", { selected: true })).toContainText("nonexistent.md", {
			timeout: 5000,
		});
	});

	test("既存ページのリンクをクリックすると遷移する", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("index.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press("Home");

		const wikilink = page.locator(".cm-wikilink:not(.cm-wikilink-missing)").first();
		await expect(wikilink).toBeVisible({ timeout: 5000 });
		await wikilink.click();

		await expect(editor).toContainText("This is a note", { timeout: 5000 });
	});
});
