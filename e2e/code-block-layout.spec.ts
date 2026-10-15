import { expect, type Page, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const FENCE = "```";
const doc = [
	"# Title",
	"",
	"before",
	"",
	`${FENCE}js`,
	"const x = 1;",
	"const y = 2;",
	FENCE,
	"",
	`> ${FENCE}js`,
	"> const q = 3;",
	`> ${FENCE}`,
	"",
	"after",
	"",
].join("\n");

const workspace = {
	files: {
		"/workspace/code.md": doc,
		"/workspace/.scripta/.initialized": "",
		"/workspace/.scripta/initialized.json": '{"initializedAt":"2026-01-01T00:00:00.000Z"}',
	},
	directories: {
		"/workspace": [{ name: "code.md", path: "/workspace/code.md", isDirectory: false }],
		"/workspace/.scripta": [],
	},
};

async function openDoc(page: Page): Promise<void> {
	const mock = new ElectronApiMock(page);
	await mock.setup({ fs: workspace, dialogResult: "/workspace" });
	await page.goto("/");
	await page.getByLabel("フォルダを開く").click();
	await page.getByLabel("code.md file").click();
	const editor = page.locator(".cm-content");
	await expect(editor).toBeVisible();
	await editor.click();
	await page.keyboard.press(`${modKey}+Home`);
	await expect(page.locator(".cm-codeblock-fence-hidden")).toHaveCount(4);
}

type LineBox = { top: number; bottom: number; height: number };
type BlockMeasure = {
	fence: LineBox;
	code: LineBox;
	textLeft: number;
	lineLeft: number;
	horizontal: number;
};

// codeText を含む行と、その直前の行 (fence) の高さ、文字と行の左端を測る
function measureBlock(page: Page, codeText: string): Promise<BlockMeasure> {
	return page.evaluate((codeText) => {
		const lines = [...document.querySelectorAll<HTMLElement>(".cm-content > .cm-line")];
		const idx = lines.findIndex((el) => el.textContent?.includes(codeText));
		const box = (el: Element) => {
			const r = el.getBoundingClientRect();
			return { top: r.top, bottom: r.bottom, height: r.height };
		};
		const code = lines[idx];
		const textNode = document.createTreeWalker(code, NodeFilter.SHOW_TEXT).nextNode();
		const range = document.createRange();
		range.selectNodeContents(textNode as Node);
		const horizontal = Number.parseFloat(
			getComputedStyle(code).getPropertyValue("--cm-horizontal-padding"),
		);
		return {
			fence: box(lines[idx - 1]),
			code: box(code),
			textLeft: range.getBoundingClientRect().left,
			lineLeft: code.getBoundingClientRect().left,
			horizontal,
		};
	}, codeText);
}

test.describe("code block layout", () => {
	test("隠れた fence 行は 1 行分の帯にならず、背景の上下の余白は約 16px", async ({ page }) => {
		await openDoc(page);
		const m = await measureBlock(page, "const x = 1;");
		const { fence } = m;
		// fence 行 + コード行の vertical padding (1px) = 背景上端から文字の行ボックスまで
		expect(fence.height + 1).toBeCloseTo(16, 0);
		expect(fence.height).toBeLessThan(m.code.height);
	});

	test("コードの文字は背景の左端から 16px 内側に始まる", async ({ page }) => {
		await openDoc(page);
		const m = await measureBlock(page, "const x = 1;");
		const bgLeft = m.lineLeft + m.horizontal;
		expect(m.textLeft - bgLeft).toBeCloseTo(16, 0);
	});

	test("引用の中のコードも、罫線分の字下げに加えて 16px 内側に始まる", async ({ page }) => {
		await openDoc(page);
		const m = await measureBlock(page, "const q = 3;");
		// 罫線 3px + 内側 8px (.cm-blockquote-line の paddingLeft)
		const quoteTextLeft = m.lineLeft + m.horizontal + 11;
		expect(m.textLeft - quoteTextLeft).toBeCloseTo(16, 0);
	});

	test("コピーボタンはコードの 1 行目の縦の範囲に収まる", async ({ page }) => {
		await openDoc(page);
		await page.locator(".cm-codeblock-copy-anchor").first().hover();
		const button = page.locator(".cm-codeblock-copy").first();
		await expect(button).toHaveClass(/cm-codeblock-copy-visible/);
		const b = await button.boundingBox();
		const m = await measureBlock(page, "const x = 1;");
		if (!b) throw new Error("copy button has no bounding box");
		expect(b.y).toBeGreaterThanOrEqual(m.code.top);
		expect(b.y + b.height).toBeLessThanOrEqual(m.code.bottom);
	});

	test("カーソルが fence 行に入ると、その行は通常の高さに戻る", async ({ page }) => {
		await openDoc(page);
		const before = await measureBlock(page, "const x = 1;");
		// 1 行目から下へ 4 回で開始 fence 行 (5 行目) に入る
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("ArrowDown");
		await expect(page.locator(".cm-codeblock-fence-hidden")).toHaveCount(3);
		const after = await measureBlock(page, "const x = 1;");
		expect(after.fence.height).toBeCloseTo(before.code.height, 0);
	});
});
