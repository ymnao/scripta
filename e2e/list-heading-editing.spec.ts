import { expect, type Page, test } from "@playwright/test";
import { waitForSaved, waitForUnsaved } from "./helpers/assertions";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

// #91（マーカー挿入後のカーソル位置）/ #92（Enter によるリスト継続）の
// 振る舞いを実 CodeMirror（renderer-only モード）で固定する。

function makeWorkspace(content: string) {
	return {
		files: {
			"/workspace/test.md": content,
			"/workspace/.scripta/initialized.json": '{"initializedAt":"2026-01-01T00:00:00.000Z"}',
		},
		directories: {
			"/workspace": [{ name: "test.md", path: "/workspace/test.md", isDirectory: false }],
		},
	};
}

// 指定内容の test.md を開き、エディタにフォーカスした状態を返す。
async function openWithContent(page: Page, content: string): Promise<ElectronApiMock> {
	const mock = new ElectronApiMock(page);
	await mock.setup({ fs: makeWorkspace(content), dialogResult: "/workspace" });
	await page.goto("/");
	await page.getByLabel("フォルダを開く").click();
	await page.getByLabel("test.md file").click();
	const editor = page.locator(".cm-content");
	await expect(editor).toBeVisible();
	await editor.click();
	return mock;
}

async function lastWrite(mock: ElectronApiMock): Promise<string> {
	const calls = await mock.getCalls("writeFile");
	return calls[calls.length - 1][1] as string;
}

test.describe("マーカー挿入後のカーソル位置 (#91)", () => {
	test("空行で Cmd+L → 入力テキストがマーカーの右に入る", async ({ page }) => {
		const mock = await openWithContent(page, "");

		await page.keyboard.press(`${modKey}+l`);
		await page.keyboard.type("task");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("- task");
	});

	test("空行で Cmd+1 → 入力テキストが見出しマーカーの右に入る", async ({ page }) => {
		const mock = await openWithContent(page, "");

		await page.keyboard.press(`${modKey}+1`);
		await page.keyboard.type("Title");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("# Title");
	});

	// 注: Cmd+Shift+L（toggleCheckbox）の e2e は意図的に置かない。
	// CM6 の keymap は Shift+文字キーを正しいバインディングに解決する際
	// keyCode→基底キー名マップ（過去のキー入力から動的構築）に依存するため、
	// ファイルを開いて即ショートカットを押す synthetic event 環境では解決が
	// 不安定になる（CI Linux で Mod-l に誤フォールバックする）。
	// toggleCheckbox のカーソル位置は formatting-commands.test.ts で決定的に
	// 検証しており、dispatchKeepingCursorRight 機構は上記 Cmd+L / Cmd+1 が
	// 同ヘルパー経由で end-to-end に担保している。
});

test.describe("Enter によるリスト継続 (#92)", () => {
	test("リスト項目末尾で Enter → 次行が - で継続", async ({ page }) => {
		const mock = await openWithContent(page, "- foo");

		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("bar");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("- foo\n- bar");
	});

	test("タスクリスト末尾で Enter → 次行が - [ ] で継続", async ({ page }) => {
		const mock = await openWithContent(page, "- [ ] foo");

		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("bar");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("- [ ] foo\n- [ ] bar");
	});

	test("順序付きリスト末尾で Enter → 番号が自動インクリメント", async ({ page }) => {
		const mock = await openWithContent(page, "1. foo");

		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("bar");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("1. foo\n2. bar");
	});

	test("blockquote 末尾で Enter → 次行が > で継続", async ({ page }) => {
		const mock = await openWithContent(page, "> foo");

		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("bar");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toContain("> foo\n> bar");
	});
});

test.describe("Tab / Shift+Tab で順序付きリストを再採番 (#118)", () => {
	test("`1. a` Enter 直後の `2. ` で Tab → 子リスト `   1. ` から再開", async ({ page }) => {
		const mock = await openWithContent(page, "1. a");

		await page.keyboard.press("End");
		await page.keyboard.press("Enter"); // → "1. a\n2. "
		await page.keyboard.press("Tab"); // → "1. a\n   1. "
		await page.keyboard.type("b");
		await page.keyboard.press("Enter"); // → "1. a\n   1. b\n   2. "
		await page.keyboard.type("c");
		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		// processContent appends a trailing newline on save. Nested indent
		// equals the parent's content offset (3 cols for "1. a") so the
		// markdown parser treats it as a proper CommonMark sub-list.
		expect(await lastWrite(mock)).toBe("1. a\n   1. b\n   2. c\n");
	});

	test("中間の項目で Tab → その項目が子レベルに下がり後続が再採番", async ({ page }) => {
		const mock = await openWithContent(page, "1. a\n2. b\n3. c");

		// 2 行目の行末へ移動して Tab
		await page.keyboard.press(`${modKey}+Home`);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("End");
		await page.keyboard.press("Tab");
		await waitForUnsaved(page);

		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toBe("1. a\n   1. b\n2. c\n");
	});

	test("子項目で Shift+Tab → 親レベルに戻り連番に復帰", async ({ page }) => {
		const mock = await openWithContent(page, "1. a\n   1. b\n2. c");

		// 2 行目の "   1. b" の行末にカーソルを置く
		await page.keyboard.press(`${modKey}+Home`);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("End");
		await page.keyboard.press("Shift+Tab");
		await waitForUnsaved(page);

		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		expect(await lastWrite(mock)).toBe("1. a\n2. b\n3. c\n");
	});

	test("ユーザ報告シナリオ: 連続した Enter で親の番号が破綻しない (#118)", async ({ page }) => {
		// 1. の行末で Enter → Tab (子の 1. を作成) → さらに改行を続けても
		// 親レベルの後続番号が壊れず保たれることを確認するリグレッション。
		// （コンテンツ付き項目で開始: insertNewlineContinueMarkup が exit branch
		//   ではなく continuation branch に入る条件）
		const mock = await openWithContent(page, "1. x\n2. y\n3. z");

		// 1 行目末尾 → Enter → Tab → 子の 1. をネスト
		await page.keyboard.press(`${modKey}+Home`);
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.press("Tab");
		await page.keyboard.type("aあ");
		await page.keyboard.press("Enter"); // 子の 2. を継続
		await page.keyboard.type("a");
		await waitForUnsaved(page);

		await page.keyboard.press(`${modKey}+s`);
		await waitForSaved(page);

		// 親 "2. y" / "3. z" がそのまま保持され、子は "   1./   2." で継続する
		expect(await lastWrite(mock)).toBe("1. x\n   1. aあ\n   2. a\n2. y\n3. z\n");
	});
});
