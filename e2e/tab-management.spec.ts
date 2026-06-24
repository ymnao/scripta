import { expect, test } from "@playwright/test";
import { ElectronApiMock, modKey } from "./helpers/electron-api-mock";

const workspace = {
	files: {
		"/workspace/hello.md": "# Hello World",
		"/workspace/notes.md": "Some notes here",
		"/workspace/todo.md": "- [ ] Task 1",
	},
	directories: {
		"/workspace": [
			{ name: "hello.md", path: "/workspace/hello.md", isDirectory: false },
			{ name: "notes.md", path: "/workspace/notes.md", isDirectory: false },
			{ name: "todo.md", path: "/workspace/todo.md", isDirectory: false },
		],
	},
};

test.describe("tab management", () => {
	test("通常クリックでアクティブタブが置き換わる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await expect(page.getByRole("tab", { selected: true })).toContainText("hello.md");

		await page.getByLabel("notes.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await expect(page.getByRole("tab", { selected: true })).toContainText("notes.md");
	});

	test("Cmd+クリックで新しいタブが開く", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(1);

		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });
		await expect(page.getByRole("tab")).toHaveCount(2);
	});

	test("タブ置き換え時にエディタの内容が切り替わる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.getByLabel("notes.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Some notes here");
	});

	test("タブ切り替え時にエディタの内容が切り替わる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });
		await expect(page.locator(".cm-content")).toContainText("Some notes here");

		await page.getByRole("tab").filter({ hasText: "hello.md" }).click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");
	});

	test("閉じるボタンでタブを閉じられる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });

		await expect(page.getByRole("tab")).toHaveCount(2);

		await page.getByLabel("Close notes.md").click();
		await expect(page.getByRole("tab")).toHaveCount(1);
	});

	test("Cmd+W でアクティブタブが閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });

		await expect(page.getByRole("tab")).toHaveCount(2);

		await page.keyboard.press(`${modKey}+w`);
		await expect(page.getByRole("tab")).toHaveCount(1);
	});

	test("ファイルタブが無いとき Cmd+W は newtab → window を閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		// workspace を開くと newtab が auto-open される
		await expect(page.getByRole("tab")).toHaveCount(1);
		await page.keyboard.press(`${modKey}+w`);
		await expect(page.getByRole("tab")).toHaveCount(0);

		// タブが無い状態の Cmd+W はウィンドウを閉じる
		await page.keyboard.press(`${modKey}+w`);
		await expect.poll(async () => (await mock.getCalls("closeWindow")).length).toBeGreaterThan(0);
	});

	test("Cmd+Shift+W はタブが残っていてもウィンドウを閉じる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(1);

		await page.keyboard.press(`${modKey}+Shift+w`);

		await expect.poll(async () => (await mock.getCalls("closeWindow")).length).toBeGreaterThan(0);
	});

	test("既に開いているファイルをクリックすると新規タブを作らず切り替わる", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();
		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });

		await expect(page.getByRole("tab")).toHaveCount(2);
		await expect(page.getByRole("tab", { selected: true })).toContainText("notes.md");

		// 既に開いているファイルを通常クリック → 新規タブを作らずに切り替わる
		await page.getByLabel("hello.md file").click();
		await expect(page.getByRole("tab")).toHaveCount(2);
		await expect(page.getByRole("tab", { selected: true })).toContainText("hello.md");
	});

	test("タブ切替後も undo / redo 履歴が維持される (#220)", async ({ page }) => {
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();

		// hello.md を編集して " updated" を追加 → undo stack に 1 entry が積まれる
		await page.getByLabel("hello.md file").click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");
		await page.locator(".cm-content").click();
		await page.keyboard.type(" updated");
		await expect(page.locator(".cm-content")).toContainText("Hello World updated");

		// notes.md タブに切り替え → cache に hello.md の EditorState が保存される
		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });
		await expect(page.locator(".cm-content")).toContainText("Some notes here");

		// hello.md タブに戻る → view.setState() で undo 履歴を含む state が復元される
		await page.getByRole("tab").filter({ hasText: "hello.md" }).click();
		await expect(page.locator(".cm-content")).toContainText("Hello World updated");

		// Cmd+Z で undo → " updated" が取り消されて編集前の状態に戻る
		await page.locator(".cm-content").click();
		await page.keyboard.press(`${modKey}+z`);
		await expect(page.locator(".cm-content")).toContainText("Hello World");
		await expect(page.locator(".cm-content")).not.toContainText("updated");

		// Cmd+Shift+Z で redo → " updated" が戻る
		await page.keyboard.press(`${modKey}+Shift+z`);
		await expect(page.locator(".cm-content")).toContainText("Hello World updated");
	});

	test("検索バー open 中に編集 → タブ切替 → 戻って undo が効く (#220)", async ({ page }) => {
		// snapshot 経由 (historyField のみ JSON 化) で保存することで、検索 compartment 等の
		// 一時 extension を含めずに undo 履歴だけを維持できる。
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		await page.getByLabel("hello.md file").click();

		// notes.md を新規タブで開いて編集する
		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });
		await expect(page.locator(".cm-content")).toContainText("Some notes here");

		// Cmd+F で SearchBar を開く → input にフォーカスが行く
		await page.locator(".cm-content").click();
		await page.keyboard.press(`${modKey}+f`);
		await page.keyboard.type("notes");

		// SearchBar 開いたまま .cm-content にフォーカスを戻して編集
		await page.locator(".cm-content").click();
		await page.keyboard.press(`${modKey}+End`);
		await page.keyboard.type(" inside search");
		await expect(page.locator(".cm-content")).toContainText("Some notes here inside search");

		// hello.md タブに切替
		await page.getByRole("tab").filter({ hasText: "hello.md" }).click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		// notes.md に戻る → snapshot から history ごと復元される
		await page.getByRole("tab").filter({ hasText: "notes.md" }).click();
		await expect(page.locator(".cm-content")).toContainText("Some notes here inside search");

		// Cmd+Z で undo → " inside search" が取り消される
		await page.locator(".cm-content").click();
		await page.keyboard.press(`${modKey}+z`);
		await expect(page.locator(".cm-content")).toContainText("Some notes here");
		await expect(page.locator(".cm-content")).not.toContainText("inside search");
	});

	test("dirty タブ切替で flush save → file watcher 通知が来ても undo 履歴が残る (#220)", async ({
		page,
	}) => {
		// 実環境では useAutoSave が filePath 変更時に dirty な prev path へ flush save し、
		// 続いて chokidar が変更検知して handleExternalFileModified を発火する。
		// この際に cache 上書きで editorState を破棄すると、戻った時に undo が効かなくなる。
		const mock = new ElectronApiMock(page);
		await mock.setup({ fs: workspace, dialogResult: "/workspace" });

		await page.goto("/");
		await page.getByLabel("フォルダを開く").click();
		// 既に開かれている newtab を閉じてからスタート
		await page.getByLabel("hello.md file").click();

		// notes.md を新規タブで開いて編集する → dirty 状態
		await page.getByLabel("notes.md file").click({ modifiers: [modKey] });
		await expect(page.locator(".cm-content")).toContainText("Some notes here");
		await page.locator(".cm-content").click();
		await page.keyboard.press(`${modKey}+End`);
		await page.keyboard.type(" edited");
		await expect(page.locator(".cm-content")).toContainText("Some notes here edited");

		// hello.md タブクリック → useAutoSave が notes.md へ flush save する
		await page.getByRole("tab").filter({ hasText: "hello.md" }).click();
		await expect(page.locator(".cm-content")).toContainText("Hello World");

		// flush save の writeFile が走るまで待つ
		await expect
			.poll(async () => (await mock.getCalls("writeFile")).length)
			.toBeGreaterThanOrEqual(1);
		const writes = await mock.getCalls("writeFile");
		const lastWrite = writes[writes.length - 1];
		const writePath = lastWrite[0] as string;
		const writeContent = lastWrite[1] as string;
		expect(writePath).toBe("/workspace/notes.md");

		// 実環境の chokidar をシミュレート: 書き込まれた内容で modify イベントを発火
		// → handleExternalFileModified が非アクティブ branch (notes.md) で動く
		await mock.simulateFileModify(writePath, writeContent);

		// notes.md に戻る → cache 上書き時に editorState が保持されていれば
		// view.setState() で undo 履歴ごと復元される
		await page.getByRole("tab").filter({ hasText: "notes.md" }).click();
		await expect(page.locator(".cm-content")).toContainText("Some notes here edited");

		// Cmd+Z で undo → " edited" が取り消される
		await page.locator(".cm-content").click();
		await page.keyboard.press(`${modKey}+z`);
		await expect(page.locator(".cm-content")).toContainText("Some notes here");
		await expect(page.locator(".cm-content")).not.toContainText("edited");
	});
});
