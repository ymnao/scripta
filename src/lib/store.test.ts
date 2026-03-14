import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStore = {
	get: vi.fn(),
	set: vi.fn(),
	save: vi.fn(),
	delete: vi.fn(),
};

vi.mock("@tauri-apps/plugin-store", () => ({
	load: vi.fn().mockResolvedValue(mockStore),
}));

const {
	loadSettings,
	saveWorkspacePath,
	saveThemePreference,
	saveSidebarVisible,
	saveShowLineNumbers,
	saveFontSize,
	saveAutoSaveDelay,
	saveHighlightActiveLine,
	saveFontFamily,
	saveTrimTrailingWhitespace,
	saveShowLinkCards,
} = await import("./store");

describe("store", () => {
	beforeEach(() => {
		mockStore.get.mockReset();
		mockStore.set.mockReset();
		mockStore.save.mockReset();
		mockStore.delete.mockReset();
		mockStore.get.mockResolvedValue(undefined);
		mockStore.set.mockResolvedValue(undefined);
		mockStore.save.mockResolvedValue(undefined);
		mockStore.delete.mockResolvedValue(undefined);
	});

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
			});
		});

		it("returns stored values when available", async () => {
			mockStore.get.mockImplementation((key: string) => {
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
				return Promise.resolve(values[key]);
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
			});
		});

		it("migrates legacy theme key to themePreference", async () => {
			mockStore.get.mockImplementation((key: string) => {
				const values: Record<string, unknown> = {
					theme: "dark",
				};
				return Promise.resolve(values[key]);
			});

			const settings = await loadSettings();
			expect(settings.themePreference).toBe("dark");
			expect(mockStore.set).toHaveBeenCalledWith("themePreference", "dark");
			expect(mockStore.delete).toHaveBeenCalledWith("theme");
			expect(mockStore.save).toHaveBeenCalled();
		});

		it("defaults to system when no theme keys exist", async () => {
			const settings = await loadSettings();
			expect(settings.themePreference).toBe("system");
		});

		it("falls back to default for out-of-range fontSize", async () => {
			mockStore.get.mockImplementation((key: string) => {
				const values: Record<string, unknown> = { fontSize: 100 };
				return Promise.resolve(values[key]);
			});
			const settings = await loadSettings();
			expect(settings.fontSize).toBe(14);
		});

		it("falls back to default for invalid fontSize type", async () => {
			mockStore.get.mockImplementation((key: string) => {
				const values: Record<string, unknown> = { fontSize: "big" };
				return Promise.resolve(values[key]);
			});
			const settings = await loadSettings();
			expect(settings.fontSize).toBe(14);
		});

		it("falls back to default for out-of-range autoSaveDelay", async () => {
			mockStore.get.mockImplementation((key: string) => {
				const values: Record<string, unknown> = { autoSaveDelay: 100 };
				return Promise.resolve(values[key]);
			});
			const settings = await loadSettings();
			expect(settings.autoSaveDelay).toBe(2000);
		});

		it("falls back to default for invalid fontFamily", async () => {
			mockStore.get.mockImplementation((key: string) => {
				const values: Record<string, unknown> = { fontFamily: "comic-sans" };
				return Promise.resolve(values[key]);
			});
			const settings = await loadSettings();
			expect(settings.fontFamily).toBe("monospace");
		});

		it("falls back to default for invalid highlightActiveLine type", async () => {
			mockStore.get.mockImplementation((key: string) => {
				const values: Record<string, unknown> = { highlightActiveLine: "yes" };
				return Promise.resolve(values[key]);
			});
			const settings = await loadSettings();
			expect(settings.highlightActiveLine).toBe(false);
		});

		it("falls back to default for invalid trimTrailingWhitespace type", async () => {
			mockStore.get.mockImplementation((key: string) => {
				const values: Record<string, unknown> = { trimTrailingWhitespace: 1 };
				return Promise.resolve(values[key]);
			});
			const settings = await loadSettings();
			expect(settings.trimTrailingWhitespace).toBe(true);
		});
	});

	describe("saveWorkspacePath", () => {
		it("saves workspace path to store", async () => {
			await saveWorkspacePath("/new/path");
			expect(mockStore.set).toHaveBeenCalledWith("workspacePath", "/new/path");
			expect(mockStore.save).toHaveBeenCalled();
		});

		it("saves null workspace path", async () => {
			await saveWorkspacePath(null);
			expect(mockStore.set).toHaveBeenCalledWith("workspacePath", null);
			expect(mockStore.save).toHaveBeenCalled();
		});
	});

	describe("saveThemePreference", () => {
		it("saves theme preference to store", async () => {
			await saveThemePreference("dark");
			expect(mockStore.set).toHaveBeenCalledWith("themePreference", "dark");
			expect(mockStore.save).toHaveBeenCalled();
		});

		it("saves system preference", async () => {
			await saveThemePreference("system");
			expect(mockStore.set).toHaveBeenCalledWith("themePreference", "system");
			expect(mockStore.save).toHaveBeenCalled();
		});
	});

	describe("saveSidebarVisible", () => {
		it("saves sidebar visibility to store", async () => {
			await saveSidebarVisible(false);
			expect(mockStore.set).toHaveBeenCalledWith("sidebarVisible", false);
			expect(mockStore.save).toHaveBeenCalled();
		});
	});

	describe("saveShowLineNumbers", () => {
		it("saves showLineNumbers to store", async () => {
			await saveShowLineNumbers(false);
			expect(mockStore.set).toHaveBeenCalledWith("showLineNumbers", false);
			expect(mockStore.save).toHaveBeenCalled();
		});

		it("saves showLineNumbers true to store", async () => {
			await saveShowLineNumbers(true);
			expect(mockStore.set).toHaveBeenCalledWith("showLineNumbers", true);
			expect(mockStore.save).toHaveBeenCalled();
		});
	});

	describe("saveFontSize", () => {
		it("saves fontSize to store", async () => {
			await saveFontSize(20);
			expect(mockStore.set).toHaveBeenCalledWith("fontSize", 20);
			expect(mockStore.save).toHaveBeenCalled();
		});
	});

	describe("saveAutoSaveDelay", () => {
		it("saves autoSaveDelay to store", async () => {
			await saveAutoSaveDelay(5000);
			expect(mockStore.set).toHaveBeenCalledWith("autoSaveDelay", 5000);
			expect(mockStore.save).toHaveBeenCalled();
		});
	});

	describe("saveHighlightActiveLine", () => {
		it("saves highlightActiveLine to store", async () => {
			await saveHighlightActiveLine(true);
			expect(mockStore.set).toHaveBeenCalledWith("highlightActiveLine", true);
			expect(mockStore.save).toHaveBeenCalled();
		});
	});

	describe("saveFontFamily", () => {
		it("saves fontFamily to store", async () => {
			await saveFontFamily("serif");
			expect(mockStore.set).toHaveBeenCalledWith("fontFamily", "serif");
			expect(mockStore.save).toHaveBeenCalled();
		});
	});

	describe("saveTrimTrailingWhitespace", () => {
		it("saves trimTrailingWhitespace to store", async () => {
			await saveTrimTrailingWhitespace(false);
			expect(mockStore.set).toHaveBeenCalledWith("trimTrailingWhitespace", false);
			expect(mockStore.save).toHaveBeenCalled();
		});
	});

	describe("saveShowLinkCards", () => {
		it("saves showLinkCards to store", async () => {
			await saveShowLinkCards(false);
			expect(mockStore.set).toHaveBeenCalledWith("showLinkCards", false);
			expect(mockStore.save).toHaveBeenCalled();
		});
	});
});
