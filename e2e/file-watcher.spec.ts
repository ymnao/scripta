import { expect, test } from "@playwright/test";
import { waitForUnsaved } from "./helpers/assertions";
import { ElectronApiMock } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/hello.md": "# Hello World",
		"/workspace/notes.md": "Some notes here",
	},
	directories: {
		"/workspace": [
			{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
			{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
		],
	},
};

test.describe("file watcher", () => {
	test("ファイル作成がファイルツリーに反映される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await expect(page.getByLabel("hello.md file")).toBeVisible();

		await mock.simulateFileCreate(
			"/workspace/new-file.md",
			"# New File",
			"/workspace",
			"new-file.md",
		);

		await expect(page.getByLabel("new-file.md file")).toBeVisible({ timeout: 2000 });
	});

	test("clean なタブのファイル更新がエディタに反映される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await mock.simulateFileModify("/workspace/hello.md", "# Updated Content");

		await expect(page.locator(".cm-content")).toContainText("Updated Content", { timeout: 2000 });
	});

	test("clean なタブのファイル削除でタブが閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.getByRole("tab")).toHaveCount(1);

		await mock.simulateFileDelete("/workspace/hello.md", "/workspace", "hello.md");

		await expect(page.getByRole("tab")).toHaveCount(0, { timeout: 2000 });
	});

	test("dirty なタブのファイル更新でコンフリクトダイアログが出る", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.locator(".cm-content").click();
		await page.keyboard.type(" edited");

		await waitForUnsaved(page);

		await mock.simulateFileModify("/workspace/hello.md", "# External Change");

		await expect(page.getByText("ファイルが外部で変更されました")).toBeVisible({ timeout: 2000 });
		await expect(page.getByRole("button", { name: "再読み込み" })).toBeVisible();
		await expect(page.getByRole("button", { name: "自分の変更を保持" })).toBeVisible();
	});

	test("dirty なタブのファイル削除で削除ダイアログが出る", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("hello.md file").click();

		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.locator(".cm-content").click();
		await page.keyboard.type(" edited");

		await waitForUnsaved(page);

		await mock.simulateFileDelete("/workspace/hello.md", "/workspace", "hello.md");

		await expect(page.getByText("ファイルが外部で削除されました")).toBeVisible({ timeout: 2000 });
		await expect(page.getByRole("button", { name: "破棄" })).toBeVisible();
		await expect(page.getByRole("button", { name: "編集を続ける" })).toBeVisible();
	});

	test("workspace 切替で新しい watcher が起動する", async ({ page }) => {
		// stopWatcher（cleanup）の検証は useFileWatcher.test.ts (unit) で実施。
		// E2E では page.goto() ごとに __E2E_API_MOCK__ が新規生成されるため
		// React の cleanup effect を観測しづらい。

		// --- workspace1 ---
		const mock1 = new ElectronApiMock(page);
		await mock1.setup({
			fs: {
				files: { "/workspace1/a.md": "# A" },
				directories: {
					"/workspace1": [{ name: "a.md", path: "/workspace1/a.md", isDirectory: false }],
				},
			},
			dialogResult: "/workspace1",
		});

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await expect(page.getByLabel("a.md file")).toBeVisible();

		const calls1 = await mock1.getCalls("startWatcher");
		expect(calls1.some((c) => c[0] === "/workspace1")).toBe(true);

		await mock1.simulateFileCreate("/workspace1/b.md", "# B", "/workspace1", "b.md");
		await expect(page.getByLabel("b.md file")).toBeVisible({ timeout: 2000 });

		// --- workspace2 ---
		const mock2 = new ElectronApiMock(page);
		await mock2.setup({
			fs: {
				files: { "/workspace2/x.md": "# X" },
				directories: {
					"/workspace2": [{ name: "x.md", path: "/workspace2/x.md", isDirectory: false }],
				},
			},
			dialogResult: "/workspace2",
		});

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await expect(page.getByLabel("x.md file")).toBeVisible();

		const calls2 = await mock2.getCalls("startWatcher");
		expect(calls2.some((c) => c[0] === "/workspace2")).toBe(true);

		await mock2.simulateFileCreate("/workspace2/y.md", "# Y", "/workspace2", "y.md");
		await expect(page.getByLabel("y.md file")).toBeVisible({ timeout: 2000 });
	});
});
