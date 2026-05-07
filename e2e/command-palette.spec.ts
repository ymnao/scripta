import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/hello.md": "# Hello",
		"/workspace/notes.md": "Notes content",
		"/workspace/readme.md": "# Readme",
	},
	directories: {
		"/workspace": [
			{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
			{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
			{ name: "readme.md", path: "/workspace/readme.md", isDirectory: false },
		],
	},
};

test.describe("command palette", () => {
	test("Cmd+P で開いて Escape で閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+p`);
		await expect(page.getByLabel("Search files by name")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByLabel("Search files by name")).not.toBeVisible();
	});

	test("開いた直後は全ファイルが表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+p`);
		await expect(page.getByText("hello.md").first()).toBeVisible();
		await expect(page.getByText("notes.md").first()).toBeVisible();
		await expect(page.getByText("readme.md").first()).toBeVisible();
	});

	test("入力でファイルが絞り込まれる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+p`);
		await page.getByLabel("Search files by name").fill("read");

		// readme.md だけがマッチする想定。ファイルツリー側の "hello.md" と区別するために
		// パレットの option（フルパスを含む）を見て non-visible を確認する。
		await expect(page.getByText("readme.md").first()).toBeVisible();
		await expect(page.getByRole("option", { name: /hello\.md.*\/workspace/ })).not.toBeVisible();
	});

	test("Enter でファイルが開く", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+p`);
		await expect(page.getByLabel("Search files by name")).toBeVisible();

		await expect(page.getByText("hello.md").first()).toBeVisible();
		await page.keyboard.press("Enter");

		await expect(page.getByLabel("Search files by name")).not.toBeVisible();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await expect(page.locator(".cm-content")).toContainText("Hello");
	});

	test("バックドロップクリックで閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		await page.keyboard.press(`${modKey}+p`);
		await expect(page.getByLabel("Search files by name")).toBeVisible();

		await page.mouse.click(10, 10);
		await expect(page.getByLabel("Search files by name")).not.toBeVisible();
	});
});
