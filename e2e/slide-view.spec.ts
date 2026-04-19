import { expect, test } from "@playwright/test";
import { modKey, TauriMock } from "./helpers/tauri-mock";

const slideContent =
	"# Slide 1\n\nIntro content\n\n---\n\n# Slide 2\n\nSecond slide\n\n---\n\n# Slide 3";

const fs = {
	files: {
		"/workspace/slides.md": slideContent,
		"/workspace/.scripta/initialized.json": '{"initializedAt":"2026-01-01T00:00:00.000Z"}',
	},
	directories: {
		"/workspace": [
			{ name: "slides.md", path: "/workspace/slides.md", isDirectory: false },
			{ name: ".scripta", path: "/workspace/.scripta", isDirectory: true },
		],
		"/workspace/.scripta": [
			{
				name: "initialized.json",
				path: "/workspace/.scripta/initialized.json",
				isDirectory: false,
			},
		],
	},
};

async function openSlideFile(page: import("@playwright/test").Page) {
	await page.goto("/");
	await page.getByLabel("Open folder").click();
	await page.getByLabel("slides.md file").click();
	const editor = page.locator(".cm-content");
	await expect(editor).toBeVisible();
	return editor;
}

test.describe("slide view", () => {
	test("opens slide view with Cmd+Shift+S and shows preview", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(fs, "/workspace");

		const editor = await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).toBeVisible();
		await expect(editor).toBeVisible();
	});

	test("closes slide view with Cmd+Shift+S", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(fs, "/workspace");

		await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).toBeVisible();

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).not.toBeVisible();
	});

	test("toggles slide view from status bar button", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(fs, "/workspace");

		await openSlideFile(page);

		await page.getByLabel("スライドビュー").click();
		await expect(page.getByText("1 / 3")).toBeVisible();

		await page.getByLabel("スライドビュー").click();
		await expect(page.getByText("1 / 3")).not.toBeVisible();
	});

	test("preview follows cursor to different slides", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(fs, "/workspace");

		await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).toBeVisible();

		// Move cursor to end of document (Slide 3) via CodeMirror API.
		// In slide view, the editor is partially overlaid by the preview pane,
		// so a regular click can't reliably focus it.
		const useMeta = modKey === "Meta";
		await page.evaluate((meta) => {
			const content = document.querySelector(".cm-content") as HTMLElement | null;
			if (!content) return;
			content.focus();
			content.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "End",
					code: "End",
					metaKey: meta,
					ctrlKey: !meta,
					bubbles: true,
					cancelable: true,
				}),
			);
		}, useMeta);

		await expect(page.getByText("3 / 3")).toBeVisible();
	});

	test("shows preview content from current slide", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(fs, "/workspace");

		await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);

		const preview = page.locator(".slide-preview-content");
		await expect(preview).toBeVisible();
		await expect(preview.getByText("Slide 1")).toBeVisible();
	});

	test("slide view shortcut is listed in help dialog", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(fs, "/workspace");

		await openSlideFile(page);

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();
		await expect(page.getByText("スライドビュー")).toBeVisible();
	});
});
