import { expect, type Page, test } from "@playwright/test";
import { openSingleFileWorkspace } from "./helpers/workspace-setup";

/**
 * live-preview の画像 widget が、読み込みで行の高さが変わった後もクリックを正しい行に
 * 解決すること (#698)。文書を画面より短くしておくのは、.cm-content が min-height で
 * 画面の高さに張り付き、CM6 が高さの変化に気付かない条件を作るため。
 */

const IMAGE_URL = "http://images.test/tall.svg";
const doc = ["top", "", "above", "", `![tall](${IMAGE_URL})`, "", "below", "", "bottom"].join("\n");

// 本文の 1 行より十分高い画像。読み込みの応答は release() を呼ぶまで返さない
async function routeTallImage(
	page: Page,
	response: { status: number } = { status: 200 },
): Promise<() => void> {
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(IMAGE_URL, async (route) => {
		await released;
		if (response.status !== 200) {
			await route.fulfill({ status: response.status, contentType: "text/plain", body: "" });
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "image/svg+xml",
			body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"></svg>',
		});
	});
	return release;
}

// 画像の行から離れた行にカーソルを置いてから読み込みを終わらせる。画像の行にカーソルが
// あると widget が外れ、読み込みの後に装飾が作り直されて、不具合の出ない経路になる
async function openAndLoad(page: Page, release: () => void): Promise<void> {
	await openSingleFileWorkspace(page, { files: { "/workspace/image.md": doc } });
	await expect(page.locator(".cm-image-widget")).toHaveCount(1);
	await page.locator(".cm-line", { hasText: "top" }).click();
	release();
}

test.describe("画像の読み込みで行の高さが変わった後のクリック (#698)", () => {
	test("読み込み後に画像の下の行をクリックすると、その行にカーソルが入る", async ({ page }) => {
		const release = await routeTallImage(page);
		await openAndLoad(page, release);
		await page.waitForFunction(() => {
			const img = document.querySelector<HTMLImageElement>(".cm-image-widget img");
			return img?.complete === true && img.naturalHeight > 0;
		});

		await page.locator(".cm-line", { hasText: "below" }).click();
		await page.keyboard.type("X");

		await expect(page.locator(".cm-line", { hasText: "X" })).toHaveText("belowX");
	});

	test("読み込みの後も <img> は作り直されず、読み込みは 1 回だけ起きる", async ({ page }) => {
		await page.addInitScript(() => {
			const w = window as unknown as { imageLoads: number };
			w.imageLoads = 0;
			document.addEventListener(
				"load",
				(e) => {
					if (e.target instanceof HTMLImageElement) w.imageLoads++;
				},
				true,
			);
		});
		const release = await routeTallImage(page);
		await openAndLoad(page, release);
		const original = await page.locator(".cm-image-widget img").elementHandle();
		await page.waitForFunction(() => (window as unknown as { imageLoads: number }).imageLoads > 0);
		// 再構築が繰り返されるなら、この間に読み込みが重なる
		await page.waitForTimeout(500);

		const result = await page.evaluate((original) => {
			return {
				loads: (window as unknown as { imageLoads: number }).imageLoads,
				same: document.querySelector(".cm-image-widget img") === original,
			};
		}, original);
		expect(result).toEqual({ loads: 1, same: true });
	});

	test("読み込みに失敗した画像の下の行も、クリックでその行にカーソルが入る", async ({ page }) => {
		const release = await routeTallImage(page, { status: 404 });
		await openAndLoad(page, release);
		await expect(page.locator(".cm-image-fallback")).toBeVisible();

		await page.locator(".cm-line", { hasText: "below" }).click();
		await page.keyboard.type("X");

		await expect(page.locator(".cm-line", { hasText: "X" })).toHaveText("belowX");
	});
});
