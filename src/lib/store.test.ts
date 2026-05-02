import { describe, expect, it, type Mock } from "vitest";
import {
	loadSettings,
	saveAutoSaveDelay,
	saveFontFamily,
	saveFontSize,
	saveHighlightActiveLine,
	saveShowLineNumbers,
	saveShowLinkCards,
	saveSidebarVisible,
	saveThemePreference,
	saveTrimTrailingWhitespace,
	saveWorkspacePath,
} from "./store";

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
			});
		});

		it("returns stored values when available", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = {
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
			});
		});

		it("migrates legacy theme key to themePreference", async () => {
			(window.api.settingsGet as Mock).mockImplementation(async (key: string) => {
				const values: Record<string, unknown> = {
					theme: "dark",
				};
				return values[key];
			});

			const settings = await loadSettings();
			expect(settings.themePreference).toBe("dark");
			expect(window.api.settingsSet).toHaveBeenCalledWith("themePreference", "dark");
			expect(window.api.settingsDelete).toHaveBeenCalledWith("theme");
			expect(window.api.settingsSave).toHaveBeenCalled();
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
	});

	describe("saveWorkspacePath", () => {
		it("saves workspace path to store", async () => {
			await saveWorkspacePath("/new/path");
			expect(window.api.settingsSet).toHaveBeenCalledWith("workspacePath", "/new/path");
			expect(window.api.settingsSave).toHaveBeenCalled();
		});

		it("saves null workspace path", async () => {
			await saveWorkspacePath(null);
			expect(window.api.settingsSet).toHaveBeenCalledWith("workspacePath", null);
			expect(window.api.settingsSave).toHaveBeenCalled();
		});
	});

	describe("saveThemePreference", () => {
		it("saves theme preference to store", async () => {
			await saveThemePreference("dark");
			expect(window.api.settingsSet).toHaveBeenCalledWith("themePreference", "dark");
			expect(window.api.settingsSave).toHaveBeenCalled();
		});

		it("saves system preference", async () => {
			await saveThemePreference("system");
			expect(window.api.settingsSet).toHaveBeenCalledWith("themePreference", "system");
			expect(window.api.settingsSave).toHaveBeenCalled();
		});
	});

	describe("saveSidebarVisible", () => {
		it("saves sidebar visibility to store", async () => {
			await saveSidebarVisible(false);
			expect(window.api.settingsSet).toHaveBeenCalledWith("sidebarVisible", false);
			expect(window.api.settingsSave).toHaveBeenCalled();
		});
	});

	describe("saveShowLineNumbers", () => {
		it("saves showLineNumbers to store", async () => {
			await saveShowLineNumbers(false);
			expect(window.api.settingsSet).toHaveBeenCalledWith("showLineNumbers", false);
			expect(window.api.settingsSave).toHaveBeenCalled();
		});

		it("saves showLineNumbers true to store", async () => {
			await saveShowLineNumbers(true);
			expect(window.api.settingsSet).toHaveBeenCalledWith("showLineNumbers", true);
			expect(window.api.settingsSave).toHaveBeenCalled();
		});
	});

	describe("saveFontSize", () => {
		it("saves fontSize to store", async () => {
			await saveFontSize(20);
			expect(window.api.settingsSet).toHaveBeenCalledWith("fontSize", 20);
			expect(window.api.settingsSave).toHaveBeenCalled();
		});
	});

	describe("saveAutoSaveDelay", () => {
		it("saves autoSaveDelay to store", async () => {
			await saveAutoSaveDelay(5000);
			expect(window.api.settingsSet).toHaveBeenCalledWith("autoSaveDelay", 5000);
			expect(window.api.settingsSave).toHaveBeenCalled();
		});
	});

	describe("saveHighlightActiveLine", () => {
		it("saves highlightActiveLine to store", async () => {
			await saveHighlightActiveLine(true);
			expect(window.api.settingsSet).toHaveBeenCalledWith("highlightActiveLine", true);
			expect(window.api.settingsSave).toHaveBeenCalled();
		});
	});

	describe("saveFontFamily", () => {
		it("saves fontFamily to store", async () => {
			await saveFontFamily("serif");
			expect(window.api.settingsSet).toHaveBeenCalledWith("fontFamily", "serif");
			expect(window.api.settingsSave).toHaveBeenCalled();
		});
	});

	describe("saveTrimTrailingWhitespace", () => {
		it("saves trimTrailingWhitespace to store", async () => {
			await saveTrimTrailingWhitespace(false);
			expect(window.api.settingsSet).toHaveBeenCalledWith("trimTrailingWhitespace", false);
			expect(window.api.settingsSave).toHaveBeenCalled();
		});
	});

	describe("saveShowLinkCards", () => {
		it("saves showLinkCards to store", async () => {
			await saveShowLinkCards(false);
			expect(window.api.settingsSet).toHaveBeenCalledWith("showLinkCards", false);
			expect(window.api.settingsSave).toHaveBeenCalled();
		});
	});
});
