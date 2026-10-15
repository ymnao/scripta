import { expect, type Page, test } from "@playwright/test";
import { waitForSaved, waitForUnsaved } from "./helpers/assertions";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";
import { openSingleFileWorkspace } from "./helpers/workspace-setup";

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
		await page.getByLabel("フォルダを開く").click();
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
		await page.getByLabel("フォルダを開く").click();
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

test.describe("上下キーで数式ブロックに入る (#643)", () => {
	const doc = "Above.\n$$\nE=mc^2\n$$\nBelow.\n";

	// `lineText` の行の先頭から `key` を 1 回押し、widget が外れたのを確かめてから
	// その位置に X を入力して保存した内容を返す
	async function pressArrowFrom(page: Page, lineText: string, key: string): Promise<string> {
		const { mock } = await openSingleFileWorkspace(page, {
			files: { "/workspace/math.md": doc },
		});
		await expect(page.locator(".cm-math-display .katex")).toBeVisible({ timeout: 5000 });

		await page.locator(".cm-line", { hasText: lineText }).click();
		await page.keyboard.press("Home");
		await page.keyboard.press(key);
		await expect(page.locator(".cm-math-display")).toHaveCount(0);
		await page.keyboard.type("X");

		await waitForUnsaved(page);
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page, 5000);

		const calls = await mock.getCalls("writeFile");
		return calls[calls.length - 1][1] as string;
	}

	test("直下の行から上キーで終わりの $$ 行に入る", async ({ page }) => {
		const content = await pressArrowFrom(page, "Below.", "ArrowUp");
		expect(content).toBe("Above.\n$$\nE=mc^2\nX$$\nBelow.\n");
	});

	test("直上の行から下キーで開始の $$ 行に入る", async ({ page }) => {
		const content = await pressArrowFrom(page, "Above.", "ArrowDown");
		expect(content).toBe("Above.\nX$$\nE=mc^2\n$$\nBelow.\n");
	});
});
