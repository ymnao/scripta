import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/note.md": "# Hello World\n\nThis is a test.",
	},
	directories: {
		"/workspace": [{ name: "note.md", path: "/workspace/note.md", isDirectory: false }],
	},
};

test.describe("export dialog", () => {
	test("メニューイベントでエクスポートダイアログが開いて HTML 出力できる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			saveDialogResult: "/export/note.html",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("note.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await mock.emitMenuEvent("export");

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("heading", { name: "エクスポート" })).toBeVisible();

		// #93 v5.4 で PDF が default になったので、HTML タブをクリックしてから出力
		await dialog.getByRole("button", { name: "HTML", exact: true }).click();
		await expect(dialog.getByRole("button", { name: "HTMLとしてエクスポート" })).toBeVisible();

		await dialog.getByRole("button", { name: "HTMLとしてエクスポート" }).click();

		await expect
			.poll(async () => {
				const calls = await mock.getCalls("writeFile");
				return calls.some(
					(c) =>
						c[0] === "/export/note.html" &&
						typeof c[1] === "string" &&
						(c[1] as string).includes("<!DOCTYPE html>"),
				);
			})
			.toBe(true);
	});

	test("キーボードショートカットでエクスポートダイアログが開く", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			saveDialogResult: "/export/note.html",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("note.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.keyboard.press(`${modKey}+Shift+E`);

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("heading", { name: "エクスポート" })).toBeVisible();
	});

	test("ファイル未選択時の menu-export は no-op", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			saveDialogResult: "/export/note.html",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		// ファイルを開かずに menu-export を発火 → ダイアログは出ない
		await mock.emitMenuEvent("export");

		const dialog = page.locator("dialog");
		await expect(dialog).not.toBeVisible({ timeout: 500 });
	});

	test("プロンプトセクションに切り替えてエクスポートできる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			saveDialogResult: "/export/note-prompt.md",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("note.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await mock.emitMenuEvent("export");

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();

		await dialog.getByRole("button", { name: "プロンプト" }).click();
		await expect(dialog.getByRole("button", { name: "プロンプトをエクスポート" })).toBeVisible();

		await dialog.getByRole("button", { name: "プロンプトをエクスポート" }).click();

		await expect
			.poll(async () => {
				const calls = await mock.getCalls("writeFile");
				return calls.some(
					(c) =>
						c[0] === "/export/note-prompt.md" &&
						typeof c[1] === "string" &&
						(c[1] as string).includes("HTML変換プロンプト"),
				);
			})
			.toBe(true);
	});

	test("PDF セクションに切り替えてエクスポートできる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			saveDialogResult: "/export/note.pdf",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("note.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await mock.emitMenuEvent("export");

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();

		// PDF tab は v5.4 で default だが、明示的にクリックして states を安定化する。
		// `{ name: "PDF", exact: true }` で「PDFとしてエクスポート」 button との strict-mode 衝突を避ける。
		await dialog.getByRole("button", { name: "PDF", exact: true }).click();
		const exportBtn = dialog.getByRole("button", { name: "PDFとしてエクスポート" });
		await expect(exportBtn).toBeVisible();

		// PDF が無効化されている環境（例: Linux CI）ではスキップ
		if (await exportBtn.isDisabled()) return;

		await exportBtn.click();

		await expect
			.poll(async () => {
				const calls = await mock.getCalls("exportPdf");
				return calls.some(
					(c) =>
						typeof c[0] === "string" &&
						(c[0] as string).includes("<!DOCTYPE html>") &&
						c[1] === "/export/note.pdf",
				);
			})
			.toBe(true);
	});

	test("セクション切り替え時にダイアログサイズが変動しない", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			saveDialogResult: "/export/note.html",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("note.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.keyboard.press(`${modKey}+Shift+E`);

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();
		const initialBox = await dialog.boundingBox();

		for (const section of ["PDF", "プロンプト", "HTML"]) {
			// `exact: true` で「PDFとしてエクスポート」「HTMLとしてエクスポート」等の
			// submit button との strict-mode 衝突を避ける。
			await dialog.getByRole("button", { name: section, exact: true }).click();
			const box = await dialog.boundingBox();
			expect(Math.abs((box?.height ?? 0) - (initialBox?.height ?? 0))).toBeLessThanOrEqual(1);
			expect(Math.abs((box?.width ?? 0) - (initialBox?.width ?? 0))).toBeLessThanOrEqual(1);
		}
	});

	test("コンテキストメニューからのエクスポートでダイアログが開く", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: workspace,
			dialogResult: "/workspace",
			saveDialogResult: "/export/note.html",
		});

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		await page.getByLabel("note.md file").click({ button: "right" });

		await page.getByText("エクスポート...").click();

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("heading", { name: "エクスポート" })).toBeVisible();
	});
});
