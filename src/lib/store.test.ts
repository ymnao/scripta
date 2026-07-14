import { describe, expect, it, type Mock } from "vitest";
import { DEFAULT_FILE_TREE_EXCLUDE_PATTERNS, loadSettings, saveSetting } from "./store";

// test-setup.ts の beforeEach が `window.api` を毎回新しい `createApiMock()` で置き換えるので、
// settingsGet のデフォルトは `undefined` を返す。各テストでは
// `(window.api.settingsGet as Mock).mockImplementation(...)` で個別の挙動を上書きする。

describe("store", () => {
	describe("loadSettings", () => {
		it("returns defaults when store has no values", async () => {
			const settings = await loadSettings();
			expect(settings).toEqual({
				workspacePath: null,
				themePreference: "system",
				sidebarVisible: true,
				showLineNumbers: true,
				fontSize: 14,
				autoSaveDelay: 2000,
				highlightActiveLine: false,
				fontFamily: "monospace",
				trimTrailingWhitespace: true,
				showLinkCards: true,
				gitSyncEnabled: false,
				autoCommitInterval: 10,
				autoPullInterval: 10,
				autoPushInterval: 10,
				pullBeforePush: true,
				syncMethod: "merge",
				commitMessage: "vault backup: {{date}}",
				autoPullOnStartup: false,
				scratchpadVolatile: true,
				autoUpdateCheck: true,
				fileTreeShowHidden: false,
				fileTreeExcludePatterns: DEFAULT_FILE_TREE_EXCLUDE_PATTERNS,
				slidePreviewWidthRatio: 0.45,
			});
		});

		it("returns stored values when available", async () => {
			// _schemaVersion=1 を seed して migration をスキップし、各 key の読み出し結果のみ検証する。
			// AppSettings には _schemaVersion を surface しないので expectations にも含めない。
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = {
					_schemaVersion: 1,
					workspacePath: "/test/path",
					themePreference: "dark",
					sidebarVisible: false,
					showLineNumbers: false,
					fontSize: 18,
					autoSaveDelay: 5000,
					highlightActiveLine: true,
					fontFamily: "serif",
					trimTrailingWhitespace: false,
					showLinkCards: false,
				};
				return values[key];
			});

			const settings = await loadSettings();
			expect(settings).toEqual({
				workspacePath: "/test/path",
				themePreference: "dark",
				sidebarVisible: false,
				showLineNumbers: false,
				fontSize: 18,
				autoSaveDelay: 5000,
				highlightActiveLine: true,
				fontFamily: "serif",
				trimTrailingWhitespace: false,
				showLinkCards: false,
				gitSyncEnabled: false,
				autoCommitInterval: 10,
				autoPullInterval: 10,
				autoPushInterval: 10,
				pullBeforePush: true,
				syncMethod: "merge",
				commitMessage: "vault backup: {{date}}",
				autoPullOnStartup: false,
				scratchpadVolatile: true,
				autoUpdateCheck: true,
				fileTreeShowHidden: false,
				fileTreeExcludePatterns: DEFAULT_FILE_TREE_EXCLUDE_PATTERNS,
				slidePreviewWidthRatio: 0.45,
			});
		});

		it("migrates legacy theme key to themePreference and bumps _schemaVersion on disk", async () => {
			// migration の効果 (settingsSet) が直後の settingsGet に反映されるよう
			// stateful な store を mock する。default mock は stateless で、
			// migration が書き込んだ themePreference="dark" を次の get が拾えない。
			const store: Record<string, unknown> = { theme: "dark" };
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) =>
				Object.hasOwn(store, key) ? store[key] : undefined,
			);
			(window.api.settingsSet as Mock).mockImplementation(async (key: string, value: unknown) => {
				store[key] = value;
			});
			(window.api.settingsDelete as Mock).mockImplementation(async (key: string) => {
				delete store[key];
			});

			const settings = await loadSettings();
			expect(settings.themePreference).toBe("dark");
			expect(window.api.settingsSet).toHaveBeenCalledWith("themePreference", "dark");
			expect(window.api.settingsSet).toHaveBeenCalledWith("_schemaVersion", 1);
			expect(window.api.settingsDelete).toHaveBeenCalledWith("theme");
			expect(window.api.settingsSave).toHaveBeenCalled();
			// settings.json 上で legacy key は削除され、_schemaVersion=1 が刻まれている。
			expect(store).not.toHaveProperty("theme");
			expect(store._schemaVersion).toBe(1);
		});

		it("skips migration when _schemaVersion is already latest", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = {
					_schemaVersion: 1,
					themePreference: "dark",
				};
				return values[key];
			});

			await loadSettings();
			// migration スキップ → settingsSet / settingsDelete / settingsSave は呼ばれない
			expect(window.api.settingsSet).not.toHaveBeenCalled();
			expect(window.api.settingsDelete).not.toHaveBeenCalled();
			expect(window.api.settingsSave).not.toHaveBeenCalled();
		});

		it("defaults to system when no theme keys exist", async () => {
			const settings = await loadSettings();
			expect(settings.themePreference).toBe("system");
		});

		it("falls back to default for out-of-range fontSize", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = { fontSize: 100 };
				return values[key];
			});
			const settings = await loadSettings();
			expect(settings.fontSize).toBe(14);
		});

		it("falls back to default for invalid fontSize type", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = { fontSize: "big" };
				return values[key];
			});
			const settings = await loadSettings();
			expect(settings.fontSize).toBe(14);
		});

		it("falls back to default for out-of-range autoSaveDelay", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = { autoSaveDelay: 100 };
				return values[key];
			});
			const settings = await loadSettings();
			expect(settings.autoSaveDelay).toBe(2000);
		});

		it("falls back to default for invalid fontFamily", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = { fontFamily: "comic-sans" };
				return values[key];
			});
			const settings = await loadSettings();
			expect(settings.fontFamily).toBe("monospace");
		});

		it("falls back to default for invalid highlightActiveLine type", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = { highlightActiveLine: "yes" };
				return values[key];
			});
			const settings = await loadSettings();
			expect(settings.highlightActiveLine).toBe(false);
		});

		it("falls back to default for invalid trimTrailingWhitespace type", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = { trimTrailingWhitespace: 1 };
				return values[key];
			});
			const settings = await loadSettings();
			expect(settings.trimTrailingWhitespace).toBe(true);
		});

		it("normalizes whitespace-only commitMessage to default on load", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = { commitMessage: "   \n  " };
				return values[key];
			});
			const settings = await loadSettings();
			expect(settings.commitMessage).toBe("vault backup: {{date}}");
		});

		it("accepts in-range slidePreviewWidthRatio", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = { slidePreviewWidthRatio: 0.6 };
				return values[key];
			});
			const settings = await loadSettings();
			expect(settings.slidePreviewWidthRatio).toBe(0.6);
		});

		it("falls back to default for out-of-range slidePreviewWidthRatio", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = { slidePreviewWidthRatio: 0.05 };
				return values[key];
			});
			expect((await loadSettings()).slidePreviewWidthRatio).toBe(0.45);

			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = { slidePreviewWidthRatio: 0.9 };
				return values[key];
			});
			expect((await loadSettings()).slidePreviewWidthRatio).toBe(0.45);
		});

		it("falls back to default for invalid slidePreviewWidthRatio type", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = { slidePreviewWidthRatio: "0.5" };
				return values[key];
			});
			const settings = await loadSettings();
			expect(settings.slidePreviewWidthRatio).toBe(0.45);
		});

		it("trims commitMessage on load", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = { commitMessage: "  backup: {{date}}  " };
				return values[key];
			});
			const settings = await loadSettings();
			expect(settings.commitMessage).toBe("backup: {{date}}");
		});
	});

	describe("saveSetting", () => {
		it("persists key/value to settings store", async () => {
			await saveSetting("themePreference", "dark");
			expect(window.api.settingsSet).toHaveBeenCalledWith("themePreference", "dark");
			expect(window.api.settingsSave).toHaveBeenCalled();
		});

		it("accepts arbitrary key/value pairs", async () => {
			await saveSetting("fontSize", 20);
			expect(window.api.settingsSet).toHaveBeenCalledWith("fontSize", 20);
			await saveSetting("sidebarVisible", false);
			expect(window.api.settingsSet).toHaveBeenCalledWith("sidebarVisible", false);
		});

		it("silently ignores errors from underlying settingsSet", async () => {
			(window.api.settingsSet as Mock).mockRejectedValueOnce(new Error("EIO"));
			// 例外が伝播しないことだけ確認 (アプリの継続動作を担保)
			await expect(saveSetting("fontSize", 20)).resolves.toBeUndefined();
		});
	});
});
