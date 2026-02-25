import { expect, test } from "@playwright/test";
import { TauriMock, modKey } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/math.md": "Hello\n\n$x^2$\n\n$$E=mc^2$$",
	},
	directories: {
		"/workspace": [{ name: "math.md", path: "/workspace/math.md", isDirectory: false }],
	},
};

test.describe("math preview", () => {
	test("renders KaTeX for inline and display math when cursor is away", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("math.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Place cursor on the first line (away from math)
		await editor.click();
		await page.keyboard.press("Home");
		await page.keyboard.press(`${modKey}+Home`);

		// Wait for KaTeX rendering
		await expect(page.locator(".cm-math-inline .katex")).toBeVisible({ timeout: 5000 });
		await expect(page.locator(".cm-math-display .katex")).toBeVisible({ timeout: 5000 });
	});

	test("hides rendered math when cursor moves to math line", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("math.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Ensure KaTeX renders when cursor is on the first line
		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);
		const inlineMath = page.locator(".cm-math-inline .katex");
		await expect(inlineMath).toBeVisible({ timeout: 5000 });

		// Move cursor to the inline math line (line 3: "$x^2$")
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");

		// The inline math widget should disappear since cursor is now on that line
		await expect(inlineMath).not.toBeVisible({ timeout: 5000 });
	});
});
