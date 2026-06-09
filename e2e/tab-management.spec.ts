import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/hello.md": "# Hello World",
		"/workspace/notes.md": "Some notes here",
		"/workspace/todo.md": "- [ ] Task 1",
	},
	directories: {
		"/workspace": [
			{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
			{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
			{ name: "todo.md", path: "/workspace/todo.md", isDirectory: false },
		],
	},
};

test.describe("tab management", () => {
	test("通常クリックでアクティブタブが置き換わる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await expect(page.getByRole("tab", { selected: true })).toContainText("hello.md");

		await page.getByLabel("notes.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await expect(page.getByRole("tab", { selected: true })).toContainText("notes.md");
	});

	test("Cmd+クリックで新しいタブが開く", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(1);

		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });
		await expect(page.getByRole("tab")).toHaveCount(2);
	});

	test("タブ置き換え時にエディタの内容が切り替わる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.getByLabel("notes.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Some notes here");
	});

	test("タブ切り替え時にエディタの内容が切り替わる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });
		await expect(page.locator(".cm-content")).toContainText("Some notes here");

		await page.getByRole("tab").filter({ hasText: "hello.md" }).click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");
	});

	test("閉じるボタンでタブを閉じられる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });

		await expect(page.getByRole("tab")).toHaveCount(2);

		await page.getByLabel("Close notes.md").click();
		await expect(page.getByRole("tab")).toHaveCount(1);
	});

	test("Cmd+W でアクティブタブが閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });

		await expect(page.getByRole("tab")).toHaveCount(2);

		await page.keyboard.press(`${modKey}+w`);
		await expect(page.getByRole("tab")).toHaveCount(1);
	});

	test("ファイルタブが無いとき Cmd+W は newtab → window を閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		// workspace を開くと newtab が auto-open される
		await expect(page.getByRole("tab")).toHaveCount(1);
		await page.keyboard.press(`${modKey}+w`);
		await expect(page.getByRole("tab")).toHaveCount(0);

		// タブが無い状態の Cmd+W はウィンドウを閉じる
		await page.keyboard.press(`${modKey}+w`);
		await expect.poll(async () => (await mock.getCalls("closeWindow")).length).toBeGreaterThan(0);
	});

	test("Cmd+Shift+W はタブが残っていてもウィンドウを閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(1);

		await page.keyboard.press(`${modKey}+Shift+w`);

		await expect.poll(async () => (await mock.getCalls("closeWindow")).length).toBeGreaterThan(0);
	});

	test("既に開いているファイルをクリックすると新規タブを作らず切り替わる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });

		await expect(page.getByRole("tab")).toHaveCount(2);
		await expect(page.getByRole("tab", { selected: true })).toContainText("notes.md");

		// 既に開いているファイルを通常クリック → 新規タブを作らずに切り替わる
		await page.getByLabel("hello.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(2);
		await expect(page.getByRole("tab", { selected: true })).toContainText("hello.md");
	});
});
