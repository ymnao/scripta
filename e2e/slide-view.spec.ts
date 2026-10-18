import { expect, test } from "@playwright/test";
import { waitForSaved, waitForUnsaved } from "./helpers/assertions";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const slideContent =
	"# Slide 1\n\nIntro content\n\n---\n\n# Slide 2\n\nSecond slide\n\n---\n\n# Slide 3";

const fs = {
	files: {
		"/workspace/slides.md": slideContent,
		"/workspace/.scripta/initialized.json": '{"initializedAt":"2026-01-01T00:00:00.000Z"}',
	},
	directories: {
		"/workspace": [
			{ name: "slides.md", path: "/workspace/slides.md", isDirectory: false },
			{ name: ".scripta", path: "/workspace/.scripta", isDirectory: true },
		],
		"/workspace/.scripta": [
			{
				name: "initialized.json",
				path: "/workspace/.scripta/initialized.json",
				isDirectory: false,
			},
		],
	},
};

async function openSlideFile(page: import("@playwright/test").Page) {
	await page.goto("/");
	await page.getByLabel("フォルダを開く").click();
	await page.getByLabel("slides.md file").click();
	const editor = page.locator(".cm-content");
	await expect(editor).toBeVisible();
	return editor;
}

async function focusEditor(page: import("@playwright/test").Page) {
	await page.evaluate(() => {
		(document.querySelector(".cm-content") as HTMLElement | null)?.focus();
	});
}

test.describe("slide view", () => {
	test("Cmd+Shift+S でスライドビューが開いてプレビューが表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		const editor = await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).toBeVisible();
		await expect(editor).toBeVisible();
	});

	test("Cmd+Shift+S でスライドビューが閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).toBeVisible();

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).not.toBeVisible();
	});

	test("ステータスバーボタンでスライドビューをトグルできる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.getByLabel("スライドビュー").click();
		await expect(page.getByText("1 / 3")).toBeVisible();

		await page.getByLabel("スライドビュー").click();
		await expect(page.getByText("1 / 3")).not.toBeVisible();
	});

	test("プレビューがカーソル位置に追従して別スライドを表示する", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).toBeVisible();

		await focusEditor(page);
		await page.keyboard.press(`${modKey}+End`);

		await expect(page.getByText("3 / 3")).toBeVisible();
	});

	test("スライドビューの左ペインに本文が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).toBeVisible();

		// .cm-content は親のスクロール領域が高さ 0 で切り取られていても自分の box を持つため、
		// toBeVisible では空のペインを検出できない。先頭行と末尾行の位置に実際に何が描かれているかを
		// 見る（末尾行も見るのは、数行分だけ残して潰れた場合も拾うため）。
		await expect
			.poll(() =>
				page.evaluate(() => {
					const lines = document.querySelectorAll(".cm-content .cm-line");
					const first = lines[0];
					const last = lines[lines.length - 1];
					if (!first || !last) return [false, false];
					return [first, last].map((line) => {
						const rect = line.getBoundingClientRect();
						const hit = document.elementFromPoint(rect.left + 4, rect.top + rect.height / 2);
						return hit !== null && line.contains(hit);
					});
				}),
			)
			.toEqual([true, true]);
	});

	test("プレビューに現在スライドの内容が表示される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);

		const preview = page.locator('[data-testid="slide-preview-pane"] .slide-preview-content');
		await expect(preview).toBeVisible();
		await expect(preview.getByText("Slide 1")).toBeVisible();
	});

	test("スライドビュー中の編集がプレビューに反映される", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);
		const preview = page.locator('[data-testid="slide-preview-pane"] .slide-preview-content');
		await expect(preview.getByText("Slide 1")).toBeVisible();

		await focusEditor(page);
		await page.keyboard.press(`${modKey}+Home`);
		// "# Slide 1" の "1" を "Z" に置き換える
		await page.keyboard.press("End");
		await page.keyboard.press("Backspace");
		await page.keyboard.type("Z");

		await expect(preview.getByText("Slide Z")).toBeVisible();
	});

	test("スライドビュー中に区切りを追加するとスライド数が増える", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 3")).toBeVisible();

		await focusEditor(page);
		await page.keyboard.press(`${modKey}+End`);
		await page.keyboard.type("\n\n---\n\n# Slide 4");

		await expect(page.getByText("4 / 4")).toBeVisible();
	});

	test.describe("自動保存の後に切り替えても編集が残る", () => {
		// 通常エディタで "# Slide 1" を "# Slide 1 EDITED" にして、自動保存まで待つ
		async function editFirstSlideAndWaitSaved(page: import("@playwright/test").Page) {
			const editor = await openSlideFile(page);
			await editor.click();
			await page.keyboard.press(`${modKey}+Home`);
			await page.keyboard.press("End");
			await page.keyboard.type(" EDITED");
			await waitForUnsaved(page);
			await waitForSaved(page, 5000);
			return editor;
		}

		test("スライドビューのエディタとプレビューに編集が残る", async ({ page }) => {
			const mock = new ElectronApiMock(page);
			await mock.setup({ fs, dialogResult: "/workspace" });

			const editor = await editFirstSlideAndWaitSaved(page);
			await page.keyboard.press(`${modKey}+Shift+s`);

			await expect(page.getByText("1 / 3")).toBeVisible();
			await expect(editor).toContainText("Slide 1 EDITED");
			const preview = page.locator('[data-testid="slide-preview-pane"] .slide-preview-content');
			await expect(preview.getByText("Slide 1 EDITED")).toBeVisible();
		});

		test("スライドビューから戻した後も編集が残る", async ({ page }) => {
			const mock = new ElectronApiMock(page);
			await mock.setup({ fs, dialogResult: "/workspace" });

			const editor = await editFirstSlideAndWaitSaved(page);
			await page.keyboard.press(`${modKey}+Shift+s`);
			await expect(page.getByText("1 / 3")).toBeVisible();
			await page.keyboard.press(`${modKey}+Shift+s`);

			await expect(page.getByText("1 / 3")).not.toBeVisible();
			await expect(editor).toContainText("Slide 1 EDITED");
		});

		test("切り替えた後の編集を保存しても先の編集がファイルから消えない", async ({ page }) => {
			const mock = new ElectronApiMock(page);
			await mock.setup({ fs, dialogResult: "/workspace" });

			await editFirstSlideAndWaitSaved(page);
			await page.keyboard.press(`${modKey}+Shift+s`);
			await expect(page.getByText("1 / 3")).toBeVisible();

			await focusEditor(page);
			await page.keyboard.press(`${modKey}+End`);
			await page.keyboard.type(" AFTER");
			await waitForUnsaved(page);
			await waitForSaved(page, 5000);

			const writes = await mock.getCalls("writeFile");
			const lastWrite = writes[writes.length - 1];
			expect(lastWrite[0]).toBe("/workspace/slides.md");
			expect(lastWrite[1]).toContain("# Slide 1 EDITED");
			expect(lastWrite[1]).toContain("# Slide 3 AFTER");
		});

		test("スライドビューへ切り替えた後もカーソル位置と undo 履歴を引き継ぐ", async ({ page }) => {
			const mock = new ElectronApiMock(page);
			await mock.setup({ fs, dialogResult: "/workspace" });

			const editor = await openSlideFile(page);
			await editor.click();
			await page.keyboard.press(`${modKey}+End`);
			await page.keyboard.type(" TAIL");
			await waitForUnsaved(page);
			await waitForSaved(page, 5000);

			await page.keyboard.press(`${modKey}+Shift+s`);
			await expect(page.getByText("3 / 3")).toBeVisible();

			await focusEditor(page);
			await page.keyboard.press(`${modKey}+z`);
			await expect(editor).not.toContainText("TAIL");
			await expect(editor).toContainText("Slide 3");
		});

		test("スライドビューから戻した後も undo 履歴を引き継ぐ", async ({ page }) => {
			const mock = new ElectronApiMock(page);
			await mock.setup({ fs, dialogResult: "/workspace" });

			const editor = await openSlideFile(page);
			await page.keyboard.press(`${modKey}+Shift+s`);
			await expect(page.getByText("1 / 3")).toBeVisible();
			await focusEditor(page);
			await page.keyboard.press(`${modKey}+End`);
			await page.keyboard.type(" IN_SLIDE");
			await expect(editor).toContainText("Slide 3 IN_SLIDE");

			await page.keyboard.press(`${modKey}+Shift+s`);
			await expect(page.getByText("3 / 3")).not.toBeVisible();
			await expect(editor).toContainText("Slide 3 IN_SLIDE");

			await focusEditor(page);
			await page.keyboard.press(`${modKey}+z`);
			await expect(editor).not.toContainText("IN_SLIDE");
		});
	});

	test("ヘルプダイアログにスライドビューのショートカットが記載されている", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs, dialogResult: "/workspace" });

		await openSlideFile(page);

		await page.keyboard.press("F1");
		await expect(page.getByText("キーボードショートカット")).toBeVisible();
		await expect(page.getByText("スライドビュー")).toBeVisible();
	});
});

const overflowSlides = [
	"# Fits\n\nshort",
	`# Tall\n\n${Array.from({ length: 12 }, (_, i) => `paragraph ${i + 1}`).join("\n\n")}`,
	`# Wide\n\n${"x".repeat(200)}`,
	"# Mermaid\n\n```mermaid\ngraph TD\nA-->B-->C-->D-->E-->F-->G-->H\n```",
	'# Float\n\n<div style="float:left;height:900px;width:10px"></div>\n\nshort',
];

const overflowFs = {
	...fs,
	files: { ...fs.files, "/workspace/slides.md": overflowSlides.join("\n\n---\n\n") },
};

test.describe("slide overflow warning", () => {
	const thumbnail = (page: import("@playwright/test").Page, n: number) =>
		page.getByRole("button", { name: `スライド ${n} を表示` });
	const previewPane = (page: import("@playwright/test").Page) =>
		page.getByTestId("slide-preview-pane");

	test.beforeEach(async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: overflowFs, dialogResult: "/workspace" });
		await openSlideFile(page);
		await page.keyboard.press(`${modKey}+Shift+s`);
		await expect(page.getByText("1 / 5")).toBeVisible();
	});

	test("収まっているスライドには、プレビューにもサムネイルにも印を出さない", async ({ page }) => {
		await expect(previewPane(page).getByText("Fits")).toBeVisible();
		await expect(previewPane(page).getByTestId("slide-overflow-bar")).toHaveCount(0);
		await expect(previewPane(page).getByText("収まっていません", { exact: true })).toHaveCount(0);
		await expect(thumbnail(page, 1).getByTestId("slide-overflow-bar")).toHaveCount(0);
		await expect(thumbnail(page, 1)).toHaveAccessibleDescription("");
	});

	test("縦にはみ出したスライドは、サムネイルに帯、プレビューにバッジを出す", async ({ page }) => {
		await expect(thumbnail(page, 2).getByTestId("slide-overflow-bar")).toBeVisible();
		await expect(thumbnail(page, 2)).toHaveAccessibleDescription("内容が枠に収まっていません");

		await thumbnail(page, 2).click();
		await expect(page.getByText("2 / 5")).toBeVisible();
		await expect(previewPane(page).getByTestId("slide-overflow-bar")).toBeVisible();
		await expect(previewPane(page).getByText("収まっていません", { exact: true })).toBeVisible();
	});

	test("横にはみ出したスライドにも印を出す", async ({ page }) => {
		await expect(thumbnail(page, 3).getByTestId("slide-overflow-bar")).toBeVisible();

		await thumbnail(page, 3).click();
		await expect(page.getByText("3 / 5")).toBeVisible();
		await expect(previewPane(page).getByText("収まっていません", { exact: true })).toBeVisible();
	});

	test("mermaid の描画で高さが伸びたら印を出す", async ({ page }) => {
		await thumbnail(page, 4).click();
		await expect(page.getByText("4 / 5")).toBeVisible();
		await expect(previewPane(page).locator(".mermaid-diagram svg")).toBeVisible();
		await expect(previewPane(page).getByText("収まっていません", { exact: true })).toBeVisible();
		await expect(thumbnail(page, 4).getByTestId("slide-overflow-bar")).toBeVisible();
	});

	test("本文の高さを伸ばさない float の子がはみ出しても印を出す", async ({ page }) => {
		await expect(thumbnail(page, 5).getByTestId("slide-overflow-bar")).toBeVisible();
	});

	test("スライドショーには、はみ出したスライドでも印を出さない", async ({ page }) => {
		await thumbnail(page, 2).click();
		await expect(previewPane(page).getByText("収まっていません", { exact: true })).toBeVisible();

		await page.keyboard.press("F5");
		const show = page.getByRole("dialog", { name: "スライド発表モード" });
		await expect(show.getByText("paragraph 1", { exact: true })).toBeVisible();
		await expect(show.getByTestId("slide-overflow-bar")).toHaveCount(0);
		await expect(show.getByText("収まっていません", { exact: true })).toHaveCount(0);
	});
});
