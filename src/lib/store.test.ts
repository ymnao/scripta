import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStore = {
	get: vi.fn(),
	set: vi.fn(),
	save: vi.fn(),
};

vi.mock("@tauri-apps/plugin-store", () => ({
	load: vi.fn().mockResolvedValue(mockStore),
}));

const { loadSettings, saveWorkspacePath, saveTheme, saveSidebarVisible } = await import("./store");

describe("store", () => {
	beforeEach(() => {
		mockStore.get.mockReset();
		mockStore.set.mockReset();
		mockStore.save.mockReset();
		mockStore.get.mockResolvedValue(undefined);
		mockStore.set.mockResolvedValue(undefined);
		mockStore.save.mockResolvedValue(undefined);
	});

	describe("loadSettings", () => {
		it("returns defaults when store has no values", async () => {
			const settings = await loadSettings();
			expect(settings).toEqual({
				workspacePath: null,
				theme: null,
				sidebarVisible: true,
			});
		});

		it("returns stored values when available", async () => {
			mockStore.get.mockImplementation((key: string) => {
				const values: Record<string, unknown> = {
					workspacePath: "/test/path",
					theme: "dark",
					sidebarVisible: false,
				};
				return Promise.resolve(values[key]);
			});

			const settings = await loadSettings();
			expect(settings).toEqual({
				workspacePath: "/test/path",
				theme: "dark",
				sidebarVisible: false,
			});
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

	describe("saveTheme", () => {
		it("saves theme to store", async () => {
			await saveTheme("dark");
			expect(mockStore.set).toHaveBeenCalledWith("theme", "dark");
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
});
