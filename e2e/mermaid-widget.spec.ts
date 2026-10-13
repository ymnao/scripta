import { expect, type Page, test } from "@playwright/test";
import { waitForSaved, waitForUnsaved } from "./helpers/assertions";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";
import { openSingleFileWorkspace } from "./helpers/workspace-setup";

const workspace = {
	files: {
		"/workspace/mermaid.md":
			"# Title\n\nSome text here.\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nMore text below.\n",
		"/workspace/.scripta/.initialized": "",
		"/workspace/.scripta/initialized.json": '{"initializedAt":"2026-01-01T00:00:00.000Z"}',
	},
	directories: {
		"/workspace": [{ name: "mermaid.md", path: "/workspace/mermaid.md", isDirectory: false }],
		"/workspace/.scripta": [],
	},
};

async function openFileAndWaitForMermaid(page: Page) {
	const mock = new ElectronApiMock(page);
	await mock.setup({ fs: workspace, dialogResult: "/workspace" });
	await page.goto("/");
	await page.getByLabel("フォルダを開く").click();
	await page.getByLabel("mermaid.md file").click();

	const editor = page.locator(".cm-content");
	await expect(editor).toBeVisible();

	// カーソルを 1 行目に移動（Mermaid ブロックから離す）
	await editor.click();
	await page.keyboard.press(`${modKey}+Home`);

	// Mermaid ウィジェットの SVG レンダリング完了を待機
	const widget = page.locator(".cm-mermaid-widget");
	await expect(widget).toBeVisible({ timeout: 15000 });
	await expect(widget.locator(".cm-mermaid-inner")).toBeVisible({ timeout: 15000 });

	return { mock, editor, widget };
}

test.describe("mermaid widget", () => {
	test.slow();

	test("左クリックでウィジェットが折りたたまれない", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		await widget.click();

		// click で focusChanged → rebuildMermaidDecos が走るが SVG は維持される
		await expect(widget.locator(".cm-mermaid-inner")).toBeVisible();
	});

	test("ウィジェット上のドラッグ選択が安定している", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		const box = await widget.boundingBox();
		if (!box) throw new Error("widget bounding box not found");

		await page.mouse.move(box.x + 5, box.y + 5);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5, {
			steps: 5,
		});
		await page.mouse.up();

		await expect(widget).toBeVisible();
	});

	test("右クリックで Mermaid コンテキストメニューが表示される", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		await widget.click({ button: "right" });

		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Mermaid を編集" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Mermaid 図を挿入" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Mermaid を削除" })).toBeVisible();

		await expect(widget).toBeVisible();
	});

	test("コンテキストメニューから編集ダイアログが開く", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		await widget.click({ button: "right" });
		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();

		await menu.getByRole("menuitem", { name: "Mermaid を編集" }).click({ force: true });

		const dialog = page.getByRole("dialog").filter({ hasText: "Mermaid エディタ" });
		await expect(dialog).toBeVisible();
		await expect(dialog.locator('[aria-label="Mermaid ソースコード"]')).toContainText("graph TD");
		await expect(menu).not.toBeVisible();
	});

	test("削除でドキュメントから Mermaid ブロックが消える", async ({ page }) => {
		const { mock, widget } = await openFileAndWaitForMermaid(page);

		await widget.click({ button: "right" });
		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();

		await menu.getByRole("menuitem", { name: "Mermaid を削除" }).click({ force: true });

		await expect(widget).not.toBeVisible();

		await waitForUnsaved(page);
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page, 5000);

		const calls = await mock.getCalls("writeFile");
		const saved = calls[calls.length - 1];
		const content = saved[1] as string;
		expect(content).not.toContain("```mermaid");
		expect(content).not.toContain("graph TD");
		expect(content).toContain("Some text here.");
		expect(content).toContain("More text below.");
	});

	test("挿入ダイアログから新しい Mermaid ブロックを追加できる", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		await widget.click({ button: "right" });
		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();

		await menu.getByRole("menuitem", { name: "Mermaid 図を挿入" }).click({ force: true });

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		// 挿入モードでは textarea は空
		const textarea = dialog.locator('[aria-label="Mermaid ソースコード"]');
		await expect(textarea).toHaveValue("");

		await textarea.fill("graph LR\n  X-->Y");
		await textarea.focus();
		await page.keyboard.press(`${modKey}+Enter`);

		await expect(dialog).not.toBeVisible();
		// 新しいブロックがウィジェットとしてレンダリングされ、合計 2 つ
		await expect(page.locator(".cm-mermaid-widget")).toHaveCount(2, { timeout: 15000 });
	});

	test("SVG が正常にレンダリングされている", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		const info = await widget.evaluate((el) => {
			const svg = el.querySelector("svg");
			if (!svg) return { error: "no svg" };

			const styleEl = svg.querySelector("style");
			const hasNodes =
				svg.querySelector(".node") !== null || svg.querySelector("foreignObject") !== null;

			return { hasStyle: !!styleEl, hasNodes, svgId: svg.getAttribute("id") };
		});

		expect(info).not.toHaveProperty("error");
		expect(info.hasNodes).toBe(true);
		expect(info.svgId).toBeTruthy();
	});

	test("テキスト → ウィジェット横断のマウスドラッグでも安定", async ({ page }) => {
		const { editor, widget } = await openFileAndWaitForMermaid(page);

		const startLine = editor.locator(".cm-line", { hasText: "Some text here." });
		const endLine = editor.locator(".cm-line", { hasText: "More text below." });

		const startBox = await startLine.boundingBox();
		const endBox = await endLine.boundingBox();
		if (!startBox || !endBox) throw new Error("line bounding box not found");

		await page.mouse.move(startBox.x + 10, startBox.y + startBox.height / 2);
		await page.mouse.down();
		await page.mouse.move(endBox.x + 10, endBox.y + endBox.height / 2, { steps: 5 });
		await page.mouse.up();

		// collectCursorLines は anchor 行（"Some text here."）のみ返すので
		// Mermaid ブロックのデコレーションは維持される
		await expect(widget.locator(".cm-mermaid-inner")).toBeVisible();
	});

	test("parse error の図は body に描画用の一時要素を残さない", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({
			fs: {
				files: {
					...workspace.files,
					"/workspace/mermaid.md":
						"# Title\n\n```mermaid\ngraph TD\n  A[[[\n```\n\nMore text below.\n",
				},
				directories: workspace.directories,
			},
			dialogResult: "/workspace",
		});
		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("mermaid.md file").click();

		const editor = page.locator(".cm-content");
		await expect(editor).toBeVisible();
		await editor.click();
		await page.keyboard.press(`${modKey}+Home`);

		await expect(page.locator(".cm-mermaid-error")).toBeVisible({ timeout: 15000 });
		// mermaid.render は描画先を渡さないと body 直下に `d<id>` の div を作る
		expect(await page.locator('body > div[id^="dmermaid-"]').count()).toBe(0);
	});
});

test.describe("mermaid widget の間の空行で上キー (#635)", () => {
	test.slow();

	// widget の高さが CM6 の height map とずれると、ずれは上にある widget の数だけ
	// 積み上がる。既定のフォントサイズでは 1 つ分のずれが半行に届かず症状が出ないので、
	// 上に 4 つ並べる。
	const blocksAbove = ["A", "B", "C", "D"]
		.map((id) => `\`\`\`mermaid\ngraph TD\n  ${id}-->${id}2\n\`\`\`\n`)
		.join("\n");
	const before = `# Title\n\n${blocksAbove}`;
	const after = "End.\n";

	// 4 つ目の widget の直後にある n 番目 (1 始まり) の空行から上キーを 1 回押し、
	// その位置に X を入力して保存した内容を返す
	async function pressArrowUpFromGapLine(page: Page, n: number): Promise<string> {
		const { mock } = await openSingleFileWorkspace(page, {
			files: { "/workspace/mermaid.md": `${before}\n\n\n${after}` },
		});

		await expect(page.locator(".cm-mermaid-inner")).toHaveCount(4, { timeout: 15000 });

		const gapLine = page
			.locator(".cm-mermaid-widget")
			.nth(3)
			.locator(`xpath=following-sibling::div[contains(@class, "cm-line")][${n}]`);
		await gapLine.click();
		await page.keyboard.press("ArrowUp");
		await page.keyboard.type("X");

		await waitForUnsaved(page);
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page, 5000);

		const calls = await mock.getCalls("writeFile");
		return calls[calls.length - 1][1] as string;
	}

	test("3 番目の空行からは 2 番目の空行へ動く", async ({ page }) => {
		const content = await pressArrowUpFromGapLine(page, 3);
		expect(content).toBe(`${before}\nX\n\n${after}`);
	});

	test("2 番目の空行からは 1 番目の空行へ動く", async ({ page }) => {
		const content = await pressArrowUpFromGapLine(page, 2);
		expect(content).toBe(`${before}X\n\n\n${after}`);
	});
});
