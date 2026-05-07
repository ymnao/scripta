import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/math.md": "Hello\n\n$x^2$\n\n$$E=mc^2$$",
	},
	directories: {
		"/workspace": [{ name: "math.md", path: "/workspace/math.md", isDirectory: false }],
	},
};

test.describe("math preview", () => {
	test("カーソルが離れているとインライン / ディスプレイ数式が KaTeX でレンダリングされる", async ({
		page,
	}) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("math.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press("Home");
		await page.keyboard.press(`${modKey}+Home`);

		await expect(page.locator(".cm-math-inline .katex")).toBeVisible({ timeout: 5000 });
		await expect(page.locator(".cm-math-display .katex")).toBeVisible({ timeout: 5000 });
	});

	test("カーソルが数式行に移動するとレンダリングが解除される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("math.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);
		const inlineMath = page.locator(".cm-math-inline .katex");
		await expect(inlineMath).toBeVisible({ timeout: 5000 });

		// "$x^2$" 行（3 行目）にカーソル移動
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");

		await expect(inlineMath).not.toBeVisible({ timeout: 5000 });
	});
});
