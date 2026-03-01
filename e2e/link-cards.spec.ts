import { expect, test } from "@playwright/test";
import { TauriMock, modKey } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/links.md":
			"Hello world\n\nhttps://example.com\n\nCheck out https://example.com inline\n\nMore text",
	},
	directories: {
		"/workspace": [{ name: "links.md", path: "/workspace/links.md", isDirectory: false }],
	},
};

function addFetchOgpMock(page: import("@playwright/test").Page) {
	return page.addInitScript(() => {
		const store = (window as unknown as { __TAURI_MOCK__: { handlers: Record<string, unknown> } })
			.__TAURI_MOCK__;
		if (store) {
			store.handlers.fetch_ogp = (args: Record<string, unknown>) => {
				const url = args.url as string;
				return {
					title: `Title for ${url}`,
					description: "A test description",
					image: null,
					siteName: "Example Site",
					url,
				};
			};
		}
	});
}

test.describe("link card preview", () => {
	test("standalone URL shows as card when cursor is away", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");
		await addFetchOgpMock(page);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("links.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Place cursor on first line (away from URL)
		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		// Wait for the link card to appear
		await expect(page.locator(".cm-link-card").first()).toBeVisible({ timeout: 10000 });
	});

	test("inline URL is not converted to card", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");
		await addFetchOgpMock(page);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("links.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Place cursor on first line
		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		// Wait for card to appear
		await expect(page.locator(".cm-link-card").first()).toBeVisible({ timeout: 10000 });

		// Verify only 1 card exists (standalone URL), not the inline one
		const cards = page.locator(".cm-link-card");
		await expect(cards).toHaveCount(1);
	});

	test("card hides when cursor moves to URL line", async ({ page }) => {
		const mock = new TauriMock(page);
		await mock.setup(workspace, "/workspace");
		await addFetchOgpMock(page);

		await page.goto("/");
		await page.getByLabel("Open folder").click();
		await page.getByLabel("links.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();

		// Place cursor on first line
		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		// Wait for card to appear
		const card = page.locator(".cm-link-card").first();
		await expect(card).toBeVisible({ timeout: 10000 });

		// Move cursor to the URL line (line 3: "https://example.com")
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");

		// Card should disappear
		await expect(card).not.toBeVisible({ timeout: 5000 });
	});
});
