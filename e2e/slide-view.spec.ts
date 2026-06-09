import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

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
	await page.getByLabel("フォルダを開く").click();
	await page.getByLabel("slides.md file").click();
	const editor = page.locator(".cm-content");
	await expect(editor).toBeVisible();
	return editor;
}

test.describe("slide view", () => {
	test("Cmd+Shift+S でスライドビューが開いてプレビューが表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		const editor = await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).toBeVisible();
		await expect(editor).toBeVisible();
	});

	test("Cmd+Shift+S でスライドビューが閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).toBeVisible();

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).not.toBeVisible();
	});

	test("ステータスバーボタンでスライドビューをトグルできる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.getByLabel("スライドビュー").click();
		await expect(page.getByText("1 / 3")).toBeVisible();

		await page.getByLabel("スライドビュー").click();
		await expect(page.getByText("1 / 3")).not.toBeVisible();
	});

	test("プレビューがカーソル位置に追従して別スライドを表示する", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).toBeVisible();

		// スライドビュー時はプレビューがエディタに被るので click でフォーカスできない。
		// 直接 focus してから Playwright の keyboard 入力を使う。
		await page.evaluate(() => {
			(document.querySelector(".cm-content") as HTMLElement | null)?.focus();
		});
		await page.keyboard.press(`${modKey}+End`);

		await expect(page.getByText("3 / 3")).toBeVisible();
	});

	test("プレビューに現在スライドの内容が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);

		const preview = page.locator(".slide-preview-content");
		await expect(preview).toBeVisible();
		await expect(preview.getByText("Slide 1")).toBeVisible();
	});

	test("ヘルプダイアログにスライドビューのショートカットが記載されている", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();
		await expect(page.getByText("スライドビュー")).toBeVisible();
	});
});
