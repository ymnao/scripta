import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/scripta-config", () => ({
	loadIcons: vi.fn(),
	saveIcons: vi.fn().mockResolvedValue(undefined),
	scriptaDirExists: vi.fn(),
}));

const {
	loadIcons: loadIconsFromDisk,
	saveIcons,
	scriptaDirExists,
} = await import("../lib/scripta-config");
const { useWorkspaceConfigStore, toRelativePath } = await import("./workspace-config");

const mockedLoadIcons = loadIconsFromDisk as Mock;
const mockedSaveIcons = saveIcons as Mock;
const mockedScriptaDirExists = scriptaDirExists as Mock;

describe("useWorkspaceConfigStore", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useWorkspaceConfigStore.setState({ icons: {}, scriptaDirReady: false });
	});

	it("has empty icons by default", () => {
		expect(useWorkspaceConfigStore.getState().icons).toEqual({});
	});

	it("has scriptaDirReady false by default", () => {
		expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(false);
	});

	describe("loadIcons", () => {
		it("loads icons from disk and sets scriptaDirReady when dir exists", async () => {
			mockedLoadIcons.mockResolvedValue({ "file.md": "📄" });
			mockedScriptaDirExists.mockResolvedValue(true);
			await useWorkspaceConfigStore.getState().loadIcons("/workspace");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({ "file.md": "📄" });
			expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(true);
		});

		it("sets scriptaDirReady true when dir exists but icons are empty", async () => {
			mockedLoadIcons.mockResolvedValue({});
			mockedScriptaDirExists.mockResolvedValue(true);
			await useWorkspaceConfigStore.getState().loadIcons("/workspace");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({});
			expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(true);
		});

		it("sets scriptaDirReady false when dir does not exist", async () => {
			mockedLoadIcons.mockResolvedValue({});
			mockedScriptaDirExists.mockResolvedValue(false);
			await useWorkspaceConfigStore.getState().loadIcons("/workspace");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({});
			expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(false);
		});
	});

	describe("setIcon", () => {
		it("adds an icon and persists to disk", () => {
			useWorkspaceConfigStore.getState().setIcon("/workspace", "file.md", "📝");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({ "file.md": "📝" });
			expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(true);
			expect(mockedSaveIcons).toHaveBeenCalledWith("/workspace", { "file.md": "📝" });
		});

		it("overwrites an existing icon", () => {
			useWorkspaceConfigStore.setState({ icons: { "file.md": "📄" } });
			useWorkspaceConfigStore.getState().setIcon("/workspace", "file.md", "🔥");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({ "file.md": "🔥" });
		});
	});

	describe("removeIcon", () => {
		it("removes an icon and persists to disk", () => {
			useWorkspaceConfigStore.setState({ icons: { "file.md": "📄", src: "🔧" } });
			useWorkspaceConfigStore.getState().removeIcon("/workspace", "file.md");
			expect(useWorkspaceConfigStore.getState().icons).toEqual({ src: "🔧" });
			expect(mockedSaveIcons).toHaveBeenCalledWith("/workspace", { src: "🔧" });
		});
	});

	describe("setScriptaDirReady", () => {
		it("sets scriptaDirReady", () => {
			useWorkspaceConfigStore.getState().setScriptaDirReady(true);
			expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(true);
		});
	});

	describe("reset", () => {
		it("resets icons and scriptaDirReady", () => {
			useWorkspaceConfigStore.setState({
				icons: { "file.md": "📄" },
				scriptaDirReady: true,
			});
			useWorkspaceConfigStore.getState().reset();
			expect(useWorkspaceConfigStore.getState().icons).toEqual({});
			expect(useWorkspaceConfigStore.getState().scriptaDirReady).toBe(false);
		});
	});
});

describe("toRelativePath", () => {
	it("strips workspace prefix from absolute path", () => {
		expect(toRelativePath("/workspace", "/workspace/file.md")).toBe("file.md");
	});

	it("strips workspace prefix from nested path", () => {
		expect(toRelativePath("/workspace", "/workspace/docs/readme.md")).toBe("docs/readme.md");
	});

	it("returns original path when prefix does not match", () => {
		expect(toRelativePath("/workspace", "/other/file.md")).toBe("/other/file.md");
	});

	it("handles Windows paths", () => {
		expect(toRelativePath("C:\\Users\\test", "C:\\Users\\test\\file.md")).toBe("file.md");
	});
});
