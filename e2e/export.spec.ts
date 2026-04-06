import { expect, test } from "@playwright/test";
import { modKey, TauriMock } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/note.md": "# Hello World\n\nThis is a test.",
	},
	directories: {
		"/workspace": [{ name: "note.md", path: "/workspace/note.md", isDirectory: false }],
	},
};

type WindowWithEvent = Window & {
	__TAURI_EVENT__?: { emit: (event: string, payload: unknown) => void };
};

test.describe("export dialog", () => {
	test("opens export dialog via menu event and exports HTML", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", undefined, "/export/note.html");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("note.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		// Trigger menu-export event
		await page.evaluate(() => {
			(window as unknown as WindowWithEvent).__TAURI_EVENT__?.emit("menu-export", undefined);
		});

		// Dialog should appear
		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("heading", { name: "エクスポート" })).toBeVisible();

		// HTML section should be active by default
		await expect(dialog.getByRole("button", { name: "HTMLとしてエクスポート" })).toBeVisible();

		// Click export button
		await dialog.getByRole("button", { name: "HTMLとしてエクスポート" }).click();

		// Wait for write_file to be called
		await expect
			.poll(async () => {
				const calls = await mock.getCalls("write_file");
				return calls.some(
					(c) =>
						c.path === "/export/note.html" &&
						typeof c.content === "string" &&
						(c.content as string).includes("<!DOCTYPE html>"),
				);
			})
			.toBe(true);
	});

	test("opens export dialog via keyboard shortcut", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", undefined, "/export/note.html");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("note.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		// Cmd+Shift+E should open export dialog
		await page.keyboard.press(`${modKey}+Shift+E`);

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("heading", { name: "エクスポート" })).toBeVisible();
	});

	test("export dialog is no-op when no file is open", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", undefined, "/export/note.html");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		// Trigger menu-export without opening a file
		await page.evaluate(() => {
			(window as unknown as WindowWithEvent).__TAURI_EVENT__?.emit("menu-export", undefined);
		});

		// Dialog should NOT appear
		await page.waitForTimeout(500);
		const dialog = page.locator("dialog");
		await expect(dialog).not.toBeVisible();
	});

	test("switches to Prompt section and exports", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", undefined, "/export/note-prompt.md");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("note.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.evaluate(() => {
			(window as unknown as WindowWithEvent).__TAURI_EVENT__?.emit("menu-export", undefined);
		});

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();

		// Switch to Prompt section
		await dialog.getByRole("button", { name: "プロンプト" }).click();
		await expect(dialog.getByRole("button", { name: "プロンプトをエクスポート" })).toBeVisible();

		// Click export
		await dialog.getByRole("button", { name: "プロンプトをエクスポート" }).click();

		// Wait for write_file to be called with prompt content
		await expect
			.poll(async () => {
				const calls = await mock.getCalls("write_file");
				return calls.some(
					(c) =>
						c.path === "/export/note-prompt.md" &&
						typeof c.content === "string" &&
						(c.content as string).includes("HTML変換プロンプト"),
				);
			})
			.toBe(true);
	});

	test("switches to PDF section and exports", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", undefined, "/export/note.pdf");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("note.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.evaluate(() => {
			(window as unknown as WindowWithEvent).__TAURI_EVENT__?.emit("menu-export", undefined);
		});

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();

		// Switch to PDF section
		await dialog.getByRole("button", { name: "PDF" }).click();
		const exportBtn = dialog.getByRole("button", { name: "PDFとしてエクスポート" });
		await expect(exportBtn).toBeVisible();

		// Skip export test if PDF is not supported on this platform (e.g. Linux CI)
		if (await exportBtn.isDisabled()) return;

		// Click export
		await exportBtn.click();

		// Wait for export_pdf to be called
		await expect
			.poll(async () => {
				const calls = await mock.getCalls("export_pdf");
				return calls.some(
					(c) =>
						typeof c.html === "string" &&
						(c.html as string).includes("<!DOCTYPE html>") &&
						c.outputPath === "/export/note.pdf",
				);
			})
			.toBe(true);
	});

	test("dialog size stays stable when switching sections", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", undefined, "/export/note.html");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("note.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.keyboard.press(`${modKey}+Shift+E`);

		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();
		const initialBox = await dialog.boundingBox();

		// セクション切り替えでサイズが変わらないことを確認
		for (const section of ["PDF", "プロンプト", "HTML"]) {
			await dialog.getByRole("button", { name: section }).click();
			const box = await dialog.boundingBox();
			expect(Math.abs((box?.height ?? 0) - (initialBox?.height ?? 0))).toBeLessThanOrEqual(1);
			expect(Math.abs((box?.width ?? 0) - (initialBox?.width ?? 0))).toBeLessThanOrEqual(1);
		}
	});

	test("context menu export opens dialog for a file", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace", undefined, "/export/note.html");

		await page.goto("/");
		await page.getByLabel("Open folder").click();

		// Right-click on the file in the tree
		await page.getByLabel("note.md file").click({ button: "right" });

		// Click "エクスポート..." in context menu
		await page.getByText("エクスポート...").click();

		// Dialog should appear
		const dialog = page.locator("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("heading", { name: "エクスポート" })).toBeVisible();
	});
});
