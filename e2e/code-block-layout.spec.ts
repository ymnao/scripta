import { expect, type Page, test } from "@playwright/test";
import { modKey } from "./helpers/electron-api-mock";
import { openSingleFileWorkspace } from "./helpers/workspace-setup";

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

async function openDoc(page: Page): Promise<void> {
	const { editor } = await openSingleFileWorkspace(page, { files: { "/workspace/code.md": doc } });
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

	test("閉じ fence 行も 1 行分の帯にならず、背景の下の余白は約 16px", async ({ page }) => {
		await openDoc(page);
		const closing = await page.evaluate(() => {
			const lines = [...document.querySelectorAll<HTMLElement>(".cm-content > .cm-line")];
			const idx = lines.findIndex((el) => el.textContent?.includes("const y = 2;"));
			return lines[idx + 1].getBoundingClientRect().height;
		});
		// コード行の vertical padding (1px) + 閉じ fence 行 = 文字の行ボックスから背景下端まで
		expect(closing + 1).toBeCloseTo(16, 0);
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
		for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
		await expect(page.locator(".cm-codeblock-fence-hidden")).toHaveCount(3);
		const after = await measureBlock(page, "const x = 1;");
		expect(after.fence.height).toBeCloseTo(before.code.height, 0);
	});
});

const plainDoc = [
	"before",
	"",
	`${FENCE}js`,
	"const x = 1;",
	"const y = 2;",
	FENCE,
	"",
	"after",
	"",
].join("\n");

async function openPlainDoc(page: Page, fontSize?: number): Promise<void> {
	const { editor } = await openSingleFileWorkspace(page, {
		files: { "/workspace/code.md": plainDoc },
		settings: fontSize === undefined ? undefined : { fontSize },
	});
	await editor.click();
	await page.keyboard.press(`${modKey}+Home`);
	await expect(page.locator(".cm-codeblock-fence-hidden")).toHaveCount(2);
	if (fontSize !== undefined) {
		await expect(page.locator(".cm-editor")).toHaveCSS("font-size", `${fontSize}px`);
	}
}

// DOM selection の focus (= head) がある .cm-line の 1 始まりの行番号
function headLine(page: Page): Promise<number> {
	return page.evaluate(() => {
		let n: Node | null = document.getSelection()?.focusNode ?? null;
		while (n && !(n instanceof HTMLElement && n.classList.contains("cm-line"))) n = n.parentNode;
		return [...document.querySelectorAll(".cm-content > .cm-line")].indexOf(n as Element) + 1;
	});
}

test.describe("潰した fence 行とカーソル移動", () => {
	// fence 行を固定 px で潰すと、文字の高さの半分より低くなった時点で moveVertically が
	// fence 行を飛び越える。設定範囲の両端 (8 / 32px) で、上下どちらからも fence 行に止まることを見る。
	// 32px は余白の比例と、置換 span の文字サイズ rule のどちらか一方でも防げる (mutation で実測:
	// 片方だけ外すと 32px の 2 件は pass し、両方外すと落ちる)。
	for (const fontSize of [8, 32]) {
		test(`文字サイズ ${fontSize}px でも、下キーは fence 行を飛ばさない`, async ({ page }) => {
			await openPlainDoc(page, fontSize);
			const visited: number[] = [];
			for (let i = 0; i < 7; i++) {
				await page.keyboard.press("ArrowDown");
				visited.push(await headLine(page));
			}
			expect(visited).toEqual([2, 3, 4, 5, 6, 7, 8]);
		});

		test(`文字サイズ ${fontSize}px でも、上キーは fence 行を飛ばさない`, async ({ page }) => {
			await openPlainDoc(page, fontSize);
			await page.keyboard.press(`${modKey}+End`);
			const visited: number[] = [];
			for (let i = 0; i < 8; i++) {
				await page.keyboard.press("ArrowUp");
				visited.push(await headLine(page));
			}
			expect(visited).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
		});
	}

	test("範囲選択の head が潰した fence 行に乗っても、キャレットに高さがある", async ({ page }) => {
		await openPlainDoc(page);
		for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Shift+ArrowDown");
		expect(await headLine(page)).toBe(6);
		// anchor は 5 行目なので閉じ fence は潰れたまま
		await expect(page.locator(".cm-codeblock-fence-hidden")).toHaveCount(2);
		// cursor layer は measure cycle で遅れて描き直されるので、fence 行の位置に描かれた
		// キャレットが現れるまで待ってから高さを見る (無ければ -1)
		await expect
			.poll(() =>
				page.evaluate(() => {
					const fence = document
						.querySelectorAll(".cm-content > .cm-line")[5]
						.getBoundingClientRect();
					const heights = [...document.querySelectorAll(".cm-cursor")]
						.map((el) => el.getBoundingClientRect())
						.filter((r) => r.top >= fence.top - 1 && r.top <= fence.bottom + 1)
						.map((r) => r.height);
					return heights.length > 0 ? Math.max(...heights) : -1;
				}),
			)
			.toBeGreaterThan(10);
	});
});

test("折り返した長いコードも、背景の右端から 16px 内側に収まる", async ({ page }) => {
	const longDoc = ["before", "", `${FENCE}js`, `const s = "${"a".repeat(800)}";`, FENCE, ""].join(
		"\n",
	);
	const { editor } = await openSingleFileWorkspace(page, {
		files: { "/workspace/code.md": longDoc },
	});
	await editor.click();
	await page.keyboard.press(`${modKey}+Home`);
	await expect(page.locator(".cm-codeblock-fence-hidden")).toHaveCount(2);
	const m = await page.evaluate(() => {
		const line = [...document.querySelectorAll<HTMLElement>(".cm-content > .cm-line")].find((el) =>
			el.textContent?.includes("const s"),
		) as HTMLElement;
		// 1 行目にはコピーボタンが入るので、行全体ではなく文字だけの rect を取る
		const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
		const rects: DOMRect[] = [];
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const range = document.createRange();
			range.selectNodeContents(n);
			rects.push(...range.getClientRects());
		}
		const horizontal = Number.parseFloat(
			getComputedStyle(line).getPropertyValue("--cm-horizontal-padding"),
		);
		return {
			rows: new Set(rects.map((r) => Math.round(r.top))).size,
			textRight: Math.max(...rects.map((r) => r.right)),
			bgRight: line.getBoundingClientRect().right - horizontal,
		};
	});
	expect(m.rows).toBeGreaterThan(1);
	expect(m.bgRight - m.textRight).toBeGreaterThanOrEqual(16 - 1);
});

test("文字サイズ 32px では、潰した fence 行の余白も文字サイズに比例する", async ({ page }) => {
	await openPlainDoc(page, 32);
	const m = await measureBlock(page, "const x = 1;");
	// 既定 14px で 16px になる比率 (16 / 14) を 32px に当てると 37px
	expect(m.fence.height + 1).toBeCloseTo(37, 0);
});
