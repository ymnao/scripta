import { expect, type Page, test } from "@playwright/test";
import { modKey, TauriMock } from "./helpers/tauri-mock";

const workspace = {
	files: {
		"/workspace/mermaid.md":
			"# Title\n\nSome text here.\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nMore text below.\n",
		"/workspace/.scripta/.initialized": "",
	},
	directories: {
		"/workspace": [{ name: "mermaid.md", path: "/workspace/mermaid.md", isDirectory: false }],
		"/workspace/.scripta": [],
	},
};

async function openFileAndWaitForMermaid(page: Page) {
	const mock = new TauriMock(page);
	await mock.setup(workspace, "/workspace");
	await page.goto("/");
	await page.getByLabel("Open folder").click();
	await page.getByLabel("mermaid.md file").click();

	const editor = page.locator(".cm-content");
	await expect(editor).toBeVisible();

	// カーソルを1行目に移動（Mermaid ブロックから離す）
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

	test("left click does not collapse the widget", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		await widget.click();

		// click で focusChanged → rebuildMermaidDecos が発火するため、
		// 再構築後も SVG が残っていることで再計算完了を確認
		await expect(widget.locator(".cm-mermaid-inner")).toBeVisible();
	});

	test("drag selection on widget stays stable", async ({ page }) => {
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

	test("right click shows mermaid context menu", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		await widget.click({ button: "right" });

		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Mermaid を編集" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Mermaid 図を挿入" })).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Mermaid を削除" })).toBeVisible();

		await expect(widget).toBeVisible();
	});

	test("edit dialog opens from context menu", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		await widget.click({ button: "right" });
		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();

		await menu.getByRole("menuitem", { name: "Mermaid を編集" }).click();

		const dialog = page.getByRole("dialog").filter({ hasText: "Mermaid エディタ" });
		await expect(dialog).toBeVisible();
		await expect(dialog.locator('[aria-label="Mermaid ソースコード"]')).toContainText("graph TD");
		await expect(menu).not.toBeVisible();
	});

	test("delete removes mermaid block from document", async ({ page }) => {
		const { mock, widget } = await openFileAndWaitForMermaid(page);

		await widget.click({ button: "right" });
		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();

		await menu.getByRole("menuitem", { name: "Mermaid を削除" }).click();

		await expect(widget).not.toBeVisible();

		await expect(page.getByText("未保存")).toBeVisible({ timeout: 5000 });
		await page.keyboard.press(`${modKey}+s`);
		await expect(page.getByText("保存済み", { exact: true })).toBeVisible({ timeout: 5000 });

		const calls = await mock.getCalls("write_file");
		const saved = calls[calls.length - 1];
		expect(saved.content).not.toContain("```mermaid");
		expect(saved.content).not.toContain("graph TD");
		expect(saved.content).toContain("Some text here.");
		expect(saved.content).toContain("More text below.");
	});

	test("insert opens dialog and adds new mermaid block", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		await widget.click({ button: "right" });
		const menu = page.locator("[role=menu]");
		await expect(menu).toBeVisible();

		await menu.getByRole("menuitem", { name: "Mermaid 図を挿入" }).click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		// 挿入モードでは textarea は空
		const textarea = dialog.locator('[aria-label="Mermaid ソースコード"]');
		await expect(textarea).toHaveValue("");

		// 新しい Mermaid コードを入力し Cmd+Enter で挿入
		await textarea.fill("graph LR\n  X-->Y");
		await textarea.focus();
		await page.keyboard.press(`${modKey}+Enter`);

		await expect(dialog).not.toBeVisible();
		// 新しいブロックがウィジェットとしてレンダリングされ、合計2つになる
		await expect(page.locator(".cm-mermaid-widget")).toHaveCount(2, { timeout: 15000 });
	});

	test("SVG が正常にレンダリングされている", async ({ page }) => {
		const { widget } = await openFileAndWaitForMermaid(page);

		const info = await widget.evaluate((el) => {
			const svg = el.querySelector("svg");
			if (!svg) return { error: "no svg" };

			const styleEl = svg.querySelector("style");
			// SVG 内にノード要素が存在するか
			const hasNodes =
				svg.querySelector(".node") !== null || svg.querySelector("foreignObject") !== null;

			return { hasStyle: !!styleEl, hasNodes, svgId: svg.getAttribute("id") };
		});

		expect(info).not.toHaveProperty("error");
		expect(info.hasNodes).toBe(true);
		expect(info.svgId).toBeTruthy();
	});

	test("mouse drag from text through mermaid widget stays stable", async ({ page }) => {
		const { editor, widget } = await openFileAndWaitForMermaid(page);

		// "Some text here." 行から "More text below." 行へマウスドラッグ
		// （Mermaid ウィジェットを横断する選択）
		const startLine = editor.locator(".cm-line", { hasText: "Some text here." });
		const endLine = editor.locator(".cm-line", { hasText: "More text below." });

		const startBox = await startLine.boundingBox();
		const endBox = await endLine.boundingBox();
		if (!startBox || !endBox) throw new Error("line bounding box not found");

		await page.mouse.move(startBox.x + 10, startBox.y + startBox.height / 2);
		await page.mouse.down();
		await page.mouse.move(endBox.x + 10, endBox.y + endBox.height / 2, { steps: 5 });
		await page.mouse.up();

		// collectCursorLines は anchor 行（"Some text here."）のみを返すため、
		// Mermaid ブロックのデコレーションは維持される
		await expect(widget.locator(".cm-mermaid-inner")).toBeVisible();
	});
});
